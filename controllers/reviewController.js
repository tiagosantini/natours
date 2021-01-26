const Review = require('../models/reviewModel');
const catchAsync = require('../utils/catchAsync');
// const AppError = require('../utils/appError');

exports.getAllReviews = catchAsync(async (req, res) => {
  const reviews = await Review.find();

  res.status(200).json({
    status: 'success',
    results: reviews.length,
    data: {
      reviews,
    },
  });
});

exports.createReview = catchAsync(async (req, res, next) => {
  const review = await Review.create(req.body);

  res.status(201).json({
    status: 'sucess',
    data: {
      review: review,
    },
  });
});
