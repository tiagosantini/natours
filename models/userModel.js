const mongoose = require('mongoose');
const validator = require('validator');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please tell us your name!'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Plese provide your email.'],
    unique: true,
    lowercase: true,
    validate: [validator.isEmail, 'Please enter a valid email.'],
  },
  photo: String,
  password: {
    type: String,
    required: [true, 'Please enter a password'],
    minLength: 8,
  },
  passwordConfirm: {
    type: String,
    required: [true, 'Please confirm your password'],
  },
});

const User = mongoose.model('User', userSchema);

module.exports = User;
