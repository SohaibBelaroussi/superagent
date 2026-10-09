// Expo's Babel preset, named so Jest transforms the ESM-only packages (.mjs) the same way Metro does.
module.exports = (api) => {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
