module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // react-native-worklets/plugin must be listed last.
    // It powers both Reanimated 4 and Skia worklet animations.
    plugins: ['react-native-worklets/plugin'],
  };
};
