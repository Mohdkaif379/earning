require('dotenv').config();
const db = require('./db');

const createUsersTable = async () => {
  try {
    const query = `
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(20) NOT NULL,
        password VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    
    await db.execute(query);
    console.log('Users table synced successfully!');
  } catch (error) {
    console.error('Error creating users table:', error.message);
  }
};

const ensureUsersStatusColumn = async () => {
  try {
    const query = `
      ALTER TABLE users
      ADD COLUMN status VARCHAR(50) NOT NULL DEFAULT 'active'
    `;
    await db.execute(query);
    console.log("Users status column added successfully!");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      console.error("Error adding status column in users table:", error.message);
    }
  }
};

const createAdminTable = async () => {
  try {
    const query = `
      CREATE TABLE IF NOT EXISTS admin (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await db.execute(query);
    console.log('Admin table synced successfully!');
  } catch (error) {
    console.error('Error creating admin table:', error.message);
  }
};

const createWalletTable = async () => {
  try {
    const query = `
      CREATE TABLE IF NOT EXISTS wallets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `;

    await db.execute(query);
    console.log("Wallet table synced successfully!");
  } catch (error) {
    console.error("Error creating wallet table:", error.message);
  }
};

const createReviewLinksTable = async () => {
  try {
    const query = `
      CREATE TABLE IF NOT EXISTS review_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        url TEXT NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await db.execute(query);
    console.log("Review links table synced successfully!");
  } catch (error) {
    console.error("Error creating review links table:", error.message);
  }
};

const createWithdrawRequestsTable = async () => {
  try {
    const query = `
      CREATE TABLE IF NOT EXISTS withdraw_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        account_holder VARCHAR(255) NOT NULL DEFAULT 'N/A',
        bank_name VARCHAR(255) NOT NULL DEFAULT 'N/A',
        account_number VARCHAR(255) NOT NULL DEFAULT 'N/A',
        ifsc_code VARCHAR(50) NOT NULL DEFAULT 'N/A',
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        reference VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_withdraw_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `;

    await db.execute(query);
    console.log("Withdraw requests table synced successfully!");
  } catch (error) {
    console.error("Error creating withdraw requests table:", error.message);
  }
};

const createRewardClicksTable = async () => {
  try {
    const query = `
      CREATE TABLE IF NOT EXISTS reward_clicks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        review_link_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_link (user_id, review_link_id),
        CONSTRAINT fk_reward_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_reward_link FOREIGN KEY (review_link_id) REFERENCES review_links(id) ON DELETE CASCADE
      )
    `;

    await db.execute(query);
    console.log("Reward clicks table synced successfully!");
  } catch (error) {
    console.error("Error creating reward clicks table:", error.message);
  }
};

const createRechargesTable = async () => {
  try {
    const query = `
      CREATE TABLE IF NOT EXISTS recharges (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        payment_method VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'completed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_recharge_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `;

    await db.execute(query);
    console.log("Recharges table synced successfully!");
  } catch (error) {
    console.error("Error creating recharges table:", error.message);
  }
};

const initDb = async () => {
  await createUsersTable();
  await ensureUsersStatusColumn();
  await createAdminTable();
  await createWalletTable();
  await createReviewLinksTable();
  await createWithdrawRequestsTable();
  await createRewardClicksTable();
  await createRechargesTable();
};

// Run if called directly
if (require.main === module) {
  initDb().then(() => process.exit());
}

module.exports = initDb;
