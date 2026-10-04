// Usage: npm run admin:hash -- "your-password"
// Prints a bcrypt hash to paste into .env as ADMIN_PASSWORD_HASH.
const bcrypt = require("bcryptjs");

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error('Usage: npm run admin:hash -- "password (min 8 chars)"');
  process.exit(1);
}
console.log(bcrypt.hashSync(password, 12));
