const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const sendEmail = require('../utils/email');

// signToken creates a new token from the user id and .env secret string
const signToken = function (id) {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

// Use signToken to create a token and send it to user
const createSendToken = (user, statusCode, res) => {
  const token = signToken(user._id);
  const cookieOptions = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
  };

  if (process.env.NODE_ENV === 'production') {
    cookieOptions.secure = true;
  }
  res.cookie('jwt', token, cookieOptions);

  // Remove password from output
  user.password = undefined;

  res.status(statusCode).json({
    status: 'success',
    token,
    data: {
      user,
    },
  });
};

// Send email confirmation token
const sendEmailToken = async (email, subject, message, res, next) => {
  try {
    await sendEmail({
      email: email,
      subject: subject,
      message: message,
    });

    res.status(200).json({
      status: 'success',
      message: 'Email sent with verification token. Check your inbox!',
    });
  } catch (err) {
    return next(
      new AppError(
        'There was an error sending the email. Try again later!',
        500
      )
    );
  }
};

// Signup process
exports.signup = catchAsync(async (req, res, next) => {
  const newUser = await User.create({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
    passwordChangedAt: req.body.passwordChangedAt,
    role: req.body.role,
  });

  const confirmationToken = await newUser.createEmailConfirmationToken();
  await newUser.save({ validateBeforeSave: false });

  const unlockURL = `${req.protocol}://${req.get(
    'host'
  )}/api/v1/users/confirmEmail/${confirmationToken}`;

  const message = `Hello, ${newUser.name}! Welcome to Natours!\nClick here to confirm your email:\n${unlockURL}`;

  // Send email confirmation token to user
  sendEmailToken(newUser.email, 'Your email confirmation token:', message, res);
});

// Email confirmation process
exports.confirmEmail = catchAsync(async (req, res, next) => {
  // 1) Get user based on the token
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await User.findOne({
    emailConfirmToken: hashedToken,
  });

  if (!user) {
    return next(new AppError('Invalid token! User does not exist.', 401));
  }
  // 2) If user is found and token matches, confirm user email
  user.confirmedEmail = true;
  user.emailConfirmToken = undefined;
  await user.save({ validateBeforeSave: false });

  // 3) Log user in, send JWT
  createSendToken(user, 200, res);
});

// Login process
exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  // 1) Check if email and password exist
  if (!email || !password) {
    return next(new AppError('Please provide email and password!', 400));
  }

  // 2) Check if user exists
  const user = await User.findOne({ email }).select('+password +loginAttempts');

  // 3) Lock account if 3 incorrect passwords are given
  if (user && !(await user.correctPassword(password, user.password))) {
    user.loginAttempts += 1;

    if (user.loginAttempts > 2) {
      user.locked = true;
    }

    user.save({ validateBeforeSave: false });
    return next(new AppError('Incorrect email or password!', 401));
  }

  // 4) Check if email and account are correct
  if (!user || !(await user.correctPassword(password, user.password))) {
    return next(new AppError('Incorrect email or password!', 401));
  }

  // 5) Check if user has confirmed their email
  if (!user.confirmedEmail) {
    return next(
      new AppError('Email was not confirmed! Please check your inbox.', 423)
    );
  }

  // 6) Log user in, send JWT
  // Reset loginAttempts
  user.loginAttempts = 0;
  createSendToken(user, 200, res);
});

// Check if user account is locked
exports.checkUserLocked = catchAsync(async (req, res, next) => {
  const { email } = req.body;

  // 1) Check if user exists
  const user = await User.findOne({ email }).select('+locked');

  if (!user) {
    return next(new AppError('User not found!', 400));
  }

  if (user.locked) {
    // 2) Generate the random reset token
    const unlockToken = user.createAccountUnlockToken();
    await user.save({ validateBeforeSave: false });

    // 3) Send token to user's email
    const unlockURL = `${req.protocol}://${req.get(
      'host'
    )}/api/v1/users/unlockAccount/${unlockToken}`;

    const message = `Locked account! Submit a PATCH request to: ${unlockURL} to unlock your account.`;
    try {
      await sendEmail({
        email: user.email,
        subject: 'Your Natours account is locked!',
        message: message,
      });
    } catch (err) {
      user.accountUnlockToken = undefined;
      await user.save({ validateBeforeSave: false });

      return next(
        new AppError(
          'There was an error sending the email. Try again later!',
          500
        )
      );
    }

    return next(
      new AppError(
        'Your account is locked! An unlock token was sent to your email.',
        423
      )
    );
  }

  next();
});

// Unlock account function
exports.unlockAccount = catchAsync(async (req, res, next) => {
  // 1) Get user based on the token
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await User.findOne({
    accountUnlockToken: hashedToken,
  });

  if (!user) {
    return next(new AppError('Invalid token! User does not exist.', 401));
  }

  // 2) If user is found and token matches, unlock account
  user.loginAttempts = 0;
  user.accountUnlockToken = undefined;
  user.locked = false;
  await user.save({ validateBeforeSave: false });

  // 3) Log user in, send JWT
  createSendToken(user, 200, res);
});

// Route protection
exports.protect = catchAsync(async (req, res, next) => {
  /* 
    --> IMPORTANT!
    --> this middleware function MUST be used to restrict access from the database for data sensitive
    --> operations such as DELETE, PATCH and PUT.
  */

  // 1) Get token and check if it's there
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401)
    );
  }
  // 2) Verify token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  // 3) Check if user still exists
  const currentUser = await User.findById(decoded.id);
  if (!currentUser) {
    return next(
      new AppError('The user beloging to this token no longer exists.', 401)
    );
  }

  // 4) Check if user changed password after token was issued
  if (currentUser.changedPasswordAfter(decoded.iat)) {
    return next(
      new AppError('User recently changed password! Please log in again.', 401)
    );
  }

  // 5) Grant access to protected route
  req.user = currentUser;
  next();
});

// Role restriction
exports.restrictTo = function (...roles) {
  /* 
    --> IMPORTANT!
    --> this middleware function MUST be used to restrict access from the database for data sensitive
    --> operations such as DELETE, PATCH and PUT.
  */

  // restrictTo takes one or more role as argument and checks if that role matches that of logged user
  // usage: authController.restrictTo('admin', 'user')
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError('You do not have permission to perform this action!', 403)
      );
    }

    next();
  };
};

// "Forgot your password?" function
exports.forgotPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on POSTed email
  const user = await User.findOne({ email: req.body.email });

  if (!user) {
    return next(new AppError('There is no user with such email address.', 404));
  }

  // 2) Generate the random reset token
  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });

  // 3) Send token to user's email
  const resetURL = `${req.protocol}://${req.get(
    'host'
  )}/api/v1/users/resetPassword/${resetToken}`;

  const message = `Forgot your password? Submit a PATCH request with your new password and passwordConfirm to: ${resetURL}.\nIf you didn't forget our password, please ignore this email!`;
  try {
    await sendEmail({
      email: user.email,
      subject: 'Your password reset token (valid for 10 min)',
      message: message,
    });

    res.status(200).json({
      status: 'success',
      message: 'Token sent to email!',
    });
  } catch (err) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });

    return next(
      new AppError(
        'There was an error sending the email. Try again later!',
        500
      )
    );
  }
});

// Password resetting
exports.resetPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on the token
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  // 2) If token has not expired, and there is a user, set the new passwordConfirm
  if (!user) {
    return next(new AppError('Token is invalid or has expired!', 400));
  }
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  // 3) Log the user in, send JWT
  createSendToken(user, 200, res);
});

// Password updating
exports.updatePassword = catchAsync(async (req, res, next) => {
  // 1) Get user from collection
  const user = await User.findById(req.user.id).select('+password');

  // 2) Check if POSTed current password is correct
  if (!(await user.correctPassword(req.body.passwordCurrent, user.password))) {
    return next(new AppError('Your current password is wrong.', 401));
  }

  // 3) if so, update password
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  await user.save();

  // 4) Log user in, send JWT
  createSendToken(user, 200, res);
});
