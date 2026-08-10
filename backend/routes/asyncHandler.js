// Wraps an async Express route handler so a rejected promise (e.g. a
// database error) is passed to Express's error middleware instead of
// crashing the whole process with an unhandled rejection.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};