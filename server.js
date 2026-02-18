const app = require("./src/app");
const createUsersTable = require("./src/config/initDb");

const PORT = 3000;

// Initialize database tables
createUsersTable();

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
