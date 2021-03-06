const mongoose = require('mongoose');
const dotenv = require('dotenv');

process.on('uncaughtException', (err) => {
  console.log('🆘 UNCAUGHT EXCEPTION! Shutting down...');
  console.log(err.name, err.message);
  process.exit(1);
});

dotenv.config({ path: './config.env' });
const app = require('./app');

// replace connection string password placeholder with the DATABASE_PASSWORD enviroment variable
// depends on config.env
const DB = process.env.DATABASE.replace(
  '<PASSWORD>',
  process.env.DATABASE_PASSWORD
);

// database connection
// useUnifiedTopology needs to be true
mongoose
  .connect(DB, {
    useNewUrlParser: true,
    useCreateIndex: true,
    useFindAndModify: false,
    useUnifiedTopology: true,
  })
  .then(() => console.log('🆗 Database connection successful! '));

// depends on enviroment variables, defaults to port 3000
const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`🆗 App running on port ${port}...`);
});

process.on('unhandledRejection', (err) => {
  console.log('🆘 UNHANDLED REJECTION! Shutting down... ');
  console.log(err.name, err.message, err.stack);

  server.close(() => {
    process.exit(1);
  });
});
