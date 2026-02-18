const express = require("express");
const path = require("path");
const session = require("express-session");
const db = require("./config/db");
const bcrypt = require("bcrypt");
const app = express();
const RECHARGE_WITHDRAW_WAIT_MS = 60 * 60 * 1000;
const RECHARGE_WALLET_CREDIT_DELAY_MINUTES = 2;
const ALLOWED_RECHARGE_AMOUNTS = [50, 100, 200, 500, 1000];
const ALLOWED_PAYMENT_METHODS = ["UPI", "PhonePe", "Paytm", "GooglePay"];

const getRechargeScannerImage = (req) => {
  const queryImage = String(req.query.scannerImage || "").trim();
  const envImage = String(process.env.RECHARGE_SCANNER_IMAGE || "").trim();
  const defaultImage = "/scanner/abc.png";
  const rawValue = queryImage || envImage || defaultImage;

  if (!rawValue) return null;
  if (/^https?:\/\//i.test(rawValue) || rawValue.startsWith("/")) {
    return rawValue;
  }
  return null;
};

const isAllowedRedirectUrl = (value) => {
  if (!value) return false;
  if (value.startsWith("/")) return true;
  const schemeMatch = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) return false;
  const scheme = schemeMatch[1].toLowerCase();
  return !["javascript", "data", "vbscript", "file"].includes(scheme);
};

const getRechargeGatewayUrl = (scannerImage) => {
  const gatewayUrl = String(process.env.RECHARGE_GATEWAY_URL || "").trim();
  if (gatewayUrl && isAllowedRedirectUrl(gatewayUrl)) {
    return gatewayUrl;
  }
  if (scannerImage && isAllowedRedirectUrl(scannerImage)) {
    return scannerImage;
  }
  return null;
};


// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware
app.use(session({
  secret: '78374364374643772',
  resave: false,
  saveUninitialized: true
}));

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use("/scanner", express.static(path.join(__dirname, "scanner")));

const requireAdminAuth = (req, res, next) => {
  if (!req.session.admin) {
    return res.redirect("/admin/login");
  }
  next();
};

const requireMemberAuth = (req, res, next) => {
  if (!req.session.member || !req.session.member.id) {
    return res.redirect("/");
  }
  next();
};

const getWithdrawEligibility = async (userId) => {
  const [rechargeRows] = await db.execute(
    `SELECT id, amount, created_at
     FROM recharges
     WHERE user_id = ? AND LOWER(status) = 'completed'
     ORDER BY id DESC
     LIMIT 1`,
    [userId]
  );

  if (!rechargeRows.length) {
    return { allowed: false, reason: "recharge_required" };
  }

  const lastRechargeAt = new Date(rechargeRows[0].created_at);
  const [lastWithdrawRows] = await db.execute(
    "SELECT id, created_at FROM withdraw_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1",
    [userId]
  );

  if (!lastWithdrawRows.length) {
    const unlockAt = new Date(lastRechargeAt.getTime() + RECHARGE_WITHDRAW_WAIT_MS);
    if (Date.now() < unlockAt.getTime()) {
      return { allowed: false, reason: "wait", unlockAt };
    }
    return { allowed: true };
  }

  const [withdrawAfterRechargeRows] = await db.execute(
    `SELECT id
     FROM withdraw_requests
     WHERE user_id = ? AND created_at > ?
     ORDER BY id ASC
     LIMIT 1`,
    [userId, lastRechargeAt]
  );

  // If user already made a withdraw after recharge, do not ask recharge again.
  if (withdrawAfterRechargeRows.length) {
    return { allowed: true };
  }

  const unlockAt = new Date(lastRechargeAt.getTime() + RECHARGE_WITHDRAW_WAIT_MS);

  if (Date.now() < unlockAt.getTime()) {
    return { allowed: false, reason: "wait", unlockAt };
  }

  return { allowed: true };
};

const settlePendingRecharges = async (userId) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [pendingRows] = await connection.execute(
      `SELECT id, amount
       FROM recharges
       WHERE user_id = ?
         AND LOWER(status) = 'pending'
         AND created_at <= DATE_SUB(NOW(), INTERVAL ${RECHARGE_WALLET_CREDIT_DELAY_MINUTES} MINUTE)
       FOR UPDATE`,
      [userId]
    );

    if (!pendingRows.length) {
      await connection.commit();
      return 0;
    }

    const totalAmount = pendingRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const rechargeIds = pendingRows.map((row) => row.id);
    const placeholders = rechargeIds.map(() => "?").join(",");

    await connection.execute(
      `UPDATE recharges SET status = 'completed' WHERE id IN (${placeholders})`,
      rechargeIds
    );

    await connection.execute(
      "INSERT INTO wallets (user_id, amount) VALUES (?, ?) ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)",
      [userId, totalAmount]
    );

    await connection.commit();
    return totalAmount;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const renderWalletPage = async (req, res, { walletError = null, walletSuccess = null } = {}) => {
  await settlePendingRecharges(req.session.member.id);
  const [walletRows] = await db.execute(
    "SELECT amount FROM wallets WHERE user_id = ? LIMIT 1",
    [req.session.member.id]
  );
  const [withdrawals] = await db.execute(
    `SELECT id, amount, account_holder, bank_name, account_number, ifsc_code, status, reference, created_at
     FROM withdraw_requests
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT 10`,
    [req.session.member.id]
  );

  const walletAmount = walletRows.length ? Number(walletRows[0].amount) || 0 : 0;
  req.session.member.wallet = walletAmount;

  return res.render("wallet", {
    name: req.session.member.name,
    wallet: walletAmount,
    walletError,
    walletSuccess,
    withdrawals
  });
};


// Test Route (Login Page)
app.get("/", (req, res) => {
  res.render("login");
});


// Signup Page
app.get("/signup", (req, res) => {
  res.render("signup");
});

// Admin Login Page
app.get("/admin/login", (req, res) => {
  res.render("admin-login");
});

// Admin Signup Page
app.get("/admin/signup", (req, res) => {
  res.render("admin-signup");
});


// Admin Signup
app.post("/admin/signup", async (req, res) => {
  try {
    const { username, password, confirmPassword } = req.body;

    if (password !== confirmPassword) {
      return res.render("admin-signup", { adminError: "Passwords do not match." });
    }
    
    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Insert admin into database
    const query = "INSERT INTO admin (username, password) VALUES (?, ?)";
    await db.execute(query, [username, hashedPassword]);
    
    // Store admin session
    req.session.admin = {
      username
    };
    
    // Redirect to admin dashboard after successful signup
    return res.redirect("/admin-dashboard");
  } catch (error) {
    console.error('Error during signup:', error.message);
    console.log("Error code:", error.code);
    
    if (error.code === 'ER_DUP_ENTRY') {
      return res.render("admin-signup", { adminError: "Username already exists!" });
    }
    return res.render("admin-signup", { adminError: "Something went wrong. Please try again." });
  }
});

// Member Signup
app.post("/member/signup", async (req, res) => {
  try {
    const { name, email, phone, password, confirmPassword } = req.body;

    if (password !== confirmPassword) {
      return res.render("signup", { memberError: "Passwords do not match." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const query = "INSERT INTO users (name, email, phone, password, status) VALUES (?, ?, ?, ?, ?)";
    const [result] = await db.execute(query, [name, email, phone, hashedPassword, "active"]);
    const userId = result.insertId;

    await db.execute(
      "INSERT INTO wallets (user_id, amount) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = user_id",
      [userId, 20]
    );

    req.session.member = {
      id: userId,
      name,
      email,
      phone,
      wallet: 20
    };

    return res.redirect("/dashboard");
  } catch (error) {
    console.error("Error during member signup:", error.message);
    if (error.code === "ER_DUP_ENTRY") {
      if (error.message.includes("email")) {
        return res.render("signup", { memberError: "Email already exists!" });
      }
      return res.render("signup", { memberError: "Member already exists!" });
    }
    return res.render("signup", { memberError: "Something went wrong. Please try again." });
  }
});

// Admin Login
app.post("/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const query = "SELECT id, username, password FROM admin WHERE username = ? LIMIT 1";
    const [rows] = await db.execute(query, [username]);

    if (!rows.length) {
      return res.render("admin-login", { adminError: "Invalid username or password." });
    }

    const admin = rows[0];
    const isPasswordValid = await bcrypt.compare(password, admin.password);

    if (!isPasswordValid) {
      return res.render("admin-login", { adminError: "Invalid username or password." });
    }

    req.session.admin = {
      username: admin.username
    };

    return res.redirect("/admin-dashboard");
  } catch (error) {
    console.error("Error during admin login:", error.message);
    return res.render("admin-login", { adminError: "Something went wrong. Please try again." });
  }
});

// Member Login
app.post("/member/login", async (req, res) => {
  try {
    const { phone, password } = req.body;

    const query = `
      SELECT u.id, u.name, u.email, u.phone, u.password, u.status, COALESCE(w.amount, 0) AS wallet
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.phone = ?
      LIMIT 1
    `;
    const [rows] = await db.execute(query, [phone]);

    if (!rows.length) {
      return res.render("login", { memberError: "Invalid phone or password." });
    }

    const member = rows[0];
    const isPasswordValid = await bcrypt.compare(password, member.password);

    if (!isPasswordValid) {
      return res.render("login", { memberError: "Invalid phone or password." });
    }

    if ((member.status || "").toLowerCase() === "block") {
      return res.render("login", { memberError: "Your account has been blocked." });
    }

    await db.execute(
      "INSERT INTO wallets (user_id, amount) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = user_id",
      [member.id, 0]
    );

    req.session.member = {
      id: member.id,
      name: member.name,
      email: member.email,
      phone: member.phone,
      wallet: Number(member.wallet) || 0
    };

    return res.redirect("/dashboard");
  } catch (error) {
    console.error("Error during member login:", error.message);
    return res.render("login", { memberError: "Something went wrong. Please try again." });
  }
});

// Admin Dashboard Page
app.get("/admin-dashboard", requireAdminAuth, async (req, res) => {
  try {
    const [users] = await db.execute(
      "SELECT id, name, email, phone, status, created_at FROM users ORDER BY id DESC"
    );
    const [reviewLinks] = await db.execute(
      "SELECT id, title, url, is_active, created_at FROM review_links ORDER BY id DESC"
    );
    const [withdrawSummary] = await db.execute(
      "SELECT COALESCE(SUM(amount), 0) AS total_withdrawn FROM withdraw_requests WHERE LOWER(status) = 'completed'"
    );
    const totalWithdrawn = withdrawSummary.length ? Number(withdrawSummary[0].total_withdrawn) || 0 : 0;

    return res.render("admin-dashboard", {
      username: req.session.admin.username,
      users,
      usersError: null,
      reviewLinks,
      totalWithdrawn,
      linkError: req.query.linkError || null,
      linkSuccess: req.query.linkSuccess || null
    });
  } catch (error) {
    console.error("Error fetching users for admin dashboard:", error.message);
    return res.render("admin-dashboard", {
      username: req.session.admin.username,
      users: [],
      usersError: "Failed to fetch users.",
      reviewLinks: [],
      totalWithdrawn: 0,
      linkError: "Failed to fetch review links.",
      linkSuccess: null
    });
  }
});

// Admin: fetch all withdrawal requests
app.get("/admin/withdraw-requests", requireAdminAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT wr.id, wr.amount, wr.status, wr.reference, wr.created_at,
              wr.account_holder, wr.bank_name, wr.account_number, wr.ifsc_code,
              u.name AS user_name, u.phone AS user_phone
       FROM withdraw_requests wr
       JOIN users u ON u.id = wr.user_id
       WHERE LOWER(wr.status) = 'pending'
       ORDER BY wr.created_at DESC`
    );
    return res.json({ ok: true, requests: rows });
  } catch (error) {
    console.error("Error fetching withdrawal requests for admin:", error.message);
    return res.status(500).json({ ok: false, requests: [] });
  }
});

// Admin: single withdrawal request page
app.get("/admin/withdraw-requests/:id", requireAdminAuth, async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    if (!requestId) {
      return res.redirect("/admin-dashboard");
    }

    const [rows] = await db.execute(
      `SELECT wr.id, wr.amount, wr.status, wr.reference, wr.created_at,
              wr.account_holder, wr.bank_name, wr.account_number, wr.ifsc_code,
              u.name AS user_name, u.phone AS user_phone, u.email AS user_email
       FROM withdraw_requests wr
       JOIN users u ON u.id = wr.user_id
       WHERE wr.id = ?
       LIMIT 1`,
      [requestId]
    );

    if (!rows.length) {
      return res.redirect("/admin-dashboard");
    }

    return res.render("admin-withdraw-request", {
      username: req.session.admin.username,
      requestData: rows[0],
      statusError: null,
      statusSuccess: req.query.statusSuccess || null
    });
  } catch (error) {
    console.error("Error loading single withdrawal request:", error.message);
    return res.redirect("/admin-dashboard");
  }
});

// Admin: update withdrawal request status
app.post("/admin/withdraw-requests/:id/status", requireAdminAuth, async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    const status = String(req.body.status || "").toLowerCase();

    if (!requestId || !["pending", "completed", "failed"].includes(status)) {
      return res.redirect(`/admin/withdraw-requests/${requestId}`);
    }

    await db.execute(
      "UPDATE withdraw_requests SET status = ? WHERE id = ?",
      [status, requestId]
    );

    return res.redirect(`/admin/withdraw-requests/${requestId}?statusSuccess=Status+updated`);
  } catch (error) {
    console.error("Error updating withdrawal request status:", error.message);
    return res.redirect(`/admin/withdraw-requests/${req.params.id}`);
  }
});

// Admin: Add review link
app.post("/admin/review-links", requireAdminAuth, async (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    let url = String(req.body.url || "").trim();

    if (!title || !url) {
      return res.redirect("/admin-dashboard?linkError=Title+aur+URL+required+hai");
    }

    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }

    await db.execute(
      "INSERT INTO review_links (title, url, is_active) VALUES (?, ?, ?)",
      [title, url, 1]
    );

    return res.redirect("/admin-dashboard?linkSuccess=Review+link+added");
  } catch (error) {
    console.error("Error adding review link:", error.message);
    return res.redirect("/admin-dashboard?linkError=Failed+to+add+review+link");
  }
});

// Admin: Delete review link
app.post("/admin/review-links/:id/delete", requireAdminAuth, async (req, res) => {
  try {
    const reviewLinkId = Number(req.params.id);
    if (!reviewLinkId) {
      return res.redirect("/admin-dashboard?linkError=Invalid+review+link");
    }

    await db.execute("DELETE FROM reward_clicks WHERE review_link_id = ?", [reviewLinkId]);
    await db.execute("DELETE FROM review_links WHERE id = ?", [reviewLinkId]);

    return res.redirect("/admin-dashboard?linkSuccess=Review+link+deleted");
  } catch (error) {
    console.error("Error deleting review link:", error.message);
    return res.redirect("/admin-dashboard?linkError=Failed+to+delete+review+link");
  }
});

// Admin: Update member status
app.post("/admin/users/:id/status", requireAdminAuth, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const status = String(req.body.status || "").toLowerCase();

    if (!userId || !["active", "block"].includes(status)) {
      return res.redirect("/admin-dashboard");
    }

    await db.execute("UPDATE users SET status = ? WHERE id = ?", [status, userId]);
    return res.redirect("/admin-dashboard");
  } catch (error) {
    console.error("Error updating user status:", error.message);
    return res.redirect("/admin-dashboard");
  }
});

// Admin: Delete member
app.post("/admin/users/:id/delete", requireAdminAuth, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!userId) {
      return res.redirect("/admin-dashboard");
    }

    await db.execute("DELETE FROM users WHERE id = ?", [userId]);
    return res.redirect("/admin-dashboard");
  } catch (error) {
    console.error("Error deleting user:", error.message);
    return res.redirect("/admin-dashboard");
  }
});

// Admin: users who made recharge
app.get("/admin/recharge-users", requireAdminAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT
        u.id,
        u.name,
        u.email,
        u.phone,
        u.status,
        u.created_at,
        COALESCE(w.amount, 0) AS wallet_amount,
        agg.total_recharges,
        agg.total_recharged,
        agg.pending_recharges,
        agg.pending_amount,
        latest.last_recharge_amount,
        latest.last_payment_method,
        latest.last_recharge_status,
        latest.last_recharge_at
      FROM users u
      JOIN (
        SELECT
          user_id,
          COUNT(*) AS total_recharges,
          COALESCE(SUM(amount), 0) AS total_recharged,
          COALESCE(SUM(CASE WHEN LOWER(status) = 'pending' THEN 1 ELSE 0 END), 0) AS pending_recharges,
          COALESCE(SUM(CASE WHEN LOWER(status) = 'pending' THEN amount ELSE 0 END), 0) AS pending_amount
        FROM recharges
        GROUP BY user_id
      ) agg ON agg.user_id = u.id
      LEFT JOIN wallets w ON w.user_id = u.id
      LEFT JOIN (
        SELECT
          r1.user_id,
          r1.amount AS last_recharge_amount,
          r1.payment_method AS last_payment_method,
          r1.status AS last_recharge_status,
          r1.created_at AS last_recharge_at
        FROM recharges r1
        JOIN (
          SELECT user_id, MAX(id) AS max_id
          FROM recharges
          GROUP BY user_id
        ) x ON x.max_id = r1.id
      ) latest ON latest.user_id = u.id
      ORDER BY latest.last_recharge_at DESC, u.id DESC`
    );

    return res.render("admin-recharge-users", {
      username: req.session.admin.username,
      rechargeUsers: rows,
      rechargeUsersError: req.query.rechargeUsersError || null,
      rechargeUsersSuccess: req.query.rechargeUsersSuccess || null
    });
  } catch (error) {
    console.error("Error fetching recharge users:", error.message);
    return res.render("admin-recharge-users", {
      username: req.session.admin.username,
      rechargeUsers: [],
      rechargeUsersError: "Failed to fetch recharge users.",
      rechargeUsersSuccess: null
    });
  }
});

// Admin: update pending recharges status for a user
app.post("/admin/recharge-users/:userId/update-pending-status", requireAdminAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  const nextStatus = String(req.body.status || "").toLowerCase();
  if (!userId) {
    return res.redirect("/admin/recharge-users?rechargeUsersError=Invalid+user");
  }
  if (!["completed", "failed"].includes(nextStatus)) {
    return res.redirect("/admin/recharge-users?rechargeUsersError=Invalid+status");
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [pendingRows] = await connection.execute(
      `SELECT id, amount
       FROM recharges
       WHERE user_id = ? AND LOWER(status) = 'pending'
       FOR UPDATE`,
      [userId]
    );

    if (!pendingRows.length) {
      await connection.rollback();
      return res.redirect("/admin/recharge-users?rechargeUsersError=No+pending+recharge+found+for+this+user");
    }

    const totalAmount = pendingRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const rechargeIds = pendingRows.map((row) => row.id);
    const placeholders = rechargeIds.map(() => "?").join(",");

    await connection.execute(
      `UPDATE recharges SET status = ? WHERE id IN (${placeholders})`,
      [nextStatus, ...rechargeIds]
    );

    if (nextStatus === "completed") {
      await connection.execute(
        "INSERT INTO wallets (user_id, amount) VALUES (?, ?) ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)",
        [userId, totalAmount]
      );
    }

    await connection.commit();

    if (nextStatus === "completed") {
      return res.redirect(`/admin/recharge-users?rechargeUsersSuccess=Completed+and+credited+Rs+${encodeURIComponent(totalAmount.toLocaleString())}`);
    }

    return res.redirect(`/admin/recharge-users?rechargeUsersSuccess=Pending+recharges+marked+as+failed`);
  } catch (error) {
    await connection.rollback();
    console.error("Error updating pending recharge status:", error.message);
    return res.redirect("/admin/recharge-users?rechargeUsersError=Failed+to+update+recharge+status");
  } finally {
    connection.release();
  }
});

// Member dashboard
app.get("/dashboard", requireMemberAuth, async (req, res) => {
  try {
    const userId = req.session.member.id;
    await settlePendingRecharges(userId);
    const [walletRows] = await db.execute(
      "SELECT amount FROM wallets WHERE user_id = ? LIMIT 1",
      [userId]
    );
    const [reviewLinks] = await db.execute(
      `SELECT rl.id, rl.title, rl.url,
       CASE WHEN rc.id IS NULL THEN 0 ELSE 1 END AS clicked
       FROM review_links rl
       LEFT JOIN reward_clicks rc
         ON rc.review_link_id = rl.id AND rc.user_id = ?
       WHERE rl.is_active = 1
       ORDER BY rl.id DESC`,
      [userId]
    );

    const walletAmount = walletRows.length ? Number(walletRows[0].amount) || 0 : 0;
    req.session.member.wallet = walletAmount;

    return res.render("dashboard", {
      name: req.session.member.name,
      email: req.session.member.email,
      wallet: walletAmount,
      reviewLinks
    });
  } catch (error) {
    console.error("Error loading member dashboard:", error.message);
    return res.render("dashboard", {
      name: req.session.member.name,
      email: req.session.member.email,
      wallet: req.session.member.wallet ?? 0,
      reviewLinks: []
    });
  }
});

// Wallet page
app.get("/wallet", requireMemberAuth, async (req, res) => {
  try {
    return await renderWalletPage(req, res);
  } catch (error) {
    console.error("Error loading wallet page:", error.message);
    return res.render("wallet", {
      name: req.session.member.name,
      wallet: req.session.member.wallet ?? 0,
      walletError: "Failed to load wallet.",
      walletSuccess: null,
      withdrawals: []
    });
  }
});

// Recharge page
app.get("/recharge", requireMemberAuth, async (req, res) => {
  try {
    await settlePendingRecharges(req.session.member.id);
    const [walletRows] = await db.execute(
      "SELECT amount FROM wallets WHERE user_id = ? LIMIT 1",
      [req.session.member.id]
    );
    const walletAmount = walletRows.length ? Number(walletRows[0].amount) || 0 : 0;
    req.session.member.wallet = walletAmount;

    const scannerImage = getRechargeScannerImage(req);
    const paymentGatewayUrl = getRechargeGatewayUrl(scannerImage);
    let unlockAtText = null;
    if (req.query.unlockAt) {
      const unlockAtDate = new Date(req.query.unlockAt);
      if (!Number.isNaN(unlockAtDate.getTime())) {
        unlockAtText = unlockAtDate.toLocaleString("en-IN");
      }
    }

    return res.render("recharge", {
      name: req.session.member.name,
      wallet: walletAmount,
      rechargeError: req.query.rechargeError || null,
      rechargeSuccess: req.query.rechargeSuccess || null,
      unlockAtText,
      scannerImage,
      paymentGatewayUrl
    });
  } catch (error) {
    console.error("Error loading recharge page:", error.message);
    const scannerImage = getRechargeScannerImage(req);
    return res.render("recharge", {
      name: req.session.member.name,
      wallet: req.session.member.wallet ?? 0,
      rechargeError: "Failed to load recharge page.",
      rechargeSuccess: null,
      unlockAtText: null,
      scannerImage,
      paymentGatewayUrl: getRechargeGatewayUrl(scannerImage)
    });
  }
});

app.post("/recharge", requireMemberAuth, async (req, res) => {
  try {
    const userId = req.session.member.id;
    const amount = Number(req.body.amount);
    const paymentMethod = String(req.body.paymentMethod || "").trim();

    if (!ALLOWED_RECHARGE_AMOUNTS.includes(amount)) {
      return res.redirect("/recharge?rechargeError=Invalid+recharge+amount");
    }

    if (!ALLOWED_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.redirect("/recharge?rechargeError=Invalid+payment+method");
    }

    await db.execute(
      "INSERT INTO recharges (user_id, amount, payment_method, status) VALUES (?, ?, ?, ?)",
      [userId, amount, paymentMethod, "pending"]
    );

    return res.redirect("/recharge?rechargeSuccess=Recharge+successful.+Wallet+update+in+2+minutes.+Withdraw+after+1+hour");
  } catch (error) {
    console.error("Error processing recharge:", error.message);
    return res.redirect("/recharge?rechargeError=Recharge+failed");
  }
});

// Wallet withdraw
app.post("/wallet/withdraw", requireMemberAuth, async (req, res) => {
  try {
    const userId = req.session.member.id;
    await settlePendingRecharges(userId);
    const eligibility = await getWithdrawEligibility(userId);

    if (!eligibility.allowed) {
      if (eligibility.reason === "wait" && eligibility.unlockAt) {
        const params = new URLSearchParams({
          rechargeError: "Withdrawal is allowed 1 hour after recharge.",
          unlockAt: eligibility.unlockAt.toISOString()
        });
        return res.redirect(`/recharge?${params.toString()}`);
      }
      return res.redirect("/recharge?rechargeError=A+recharge+is+required+before+withdrawal");
    }

    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 20) {
      return await renderWalletPage(req, res, {
        walletError: "Enter a valid amount (minimum 20)."
      });
    }

    const [rows] = await db.execute("SELECT amount FROM wallets WHERE user_id = ? LIMIT 1", [req.session.member.id]);
    const currentAmount = rows.length ? Number(rows[0].amount) || 0 : 0;

    if (amount > currentAmount) {
      return await renderWalletPage(req, res, {
        walletError: "Insufficient balance."
      });
    }

    const accountHolder = String(req.body.account_holder || "").trim() || "N/A";
    const bankName = String(req.body.bank_name || "").trim() || "N/A";
    const accountNumber = String(req.body.account_number || "").trim() || "N/A";
    const ifscCode = String(req.body.ifsc_code || "").trim() || "N/A";
    const reference = `WD${Date.now()}${Math.floor(Math.random() * 1000)}`;

    await db.execute(
      "UPDATE wallets SET amount = amount - ? WHERE user_id = ?",
      [amount, userId]
    );
    await db.execute(
      `INSERT INTO withdraw_requests
      (user_id, amount, account_holder, bank_name, account_number, ifsc_code, status, reference)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, amount, accountHolder, bankName, accountNumber, ifscCode, "pending", reference]
    );

    return await renderWalletPage(req, res, {
      walletSuccess: `Withdraw request submitted: ${amount} (pending)`
    });
  } catch (error) {
    console.error("Error withdrawing wallet amount:", error.message);
    return await renderWalletPage(req, res, {
      walletError: "Withdraw process failed."
    });
  }
});

// Member reward click (+10 wallet)
app.post("/dashboard/reward", requireMemberAuth, async (req, res) => {
  try {
    const userId = req.session.member.id;
    const reviewLinkId = Number(req.body.reviewLinkId);

    if (!reviewLinkId) {
      return res.status(400).json({ ok: false, message: "Invalid link." });
    }

    const [linkRows] = await db.execute(
      "SELECT id FROM review_links WHERE id = ? AND is_active = 1 LIMIT 1",
      [reviewLinkId]
    );
    if (!linkRows.length) {
      return res.status(404).json({ ok: false, message: "Link not found." });
    }

    try {
      await db.execute(
        "INSERT INTO reward_clicks (user_id, review_link_id) VALUES (?, ?)",
        [userId, reviewLinkId]
      );
    } catch (insertErr) {
      if (insertErr.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ ok: false, message: "Already claimed." });
      }
      throw insertErr;
    }

    await db.execute(
      "INSERT INTO wallets (user_id, amount) VALUES (?, ?) ON DUPLICATE KEY UPDATE amount = amount + 10",
      [userId, 10]
    );
    return res.json({ ok: true, message: "Reward added." });
  } catch (error) {
    console.error("Error updating wallet reward:", error.message);
    return res.status(500).json({ ok: false, message: "Reward failed." });
  }
});


app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    return res.redirect("/");
  });
});



module.exports = app;
