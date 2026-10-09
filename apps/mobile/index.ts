// The app's entry: settings that must come before any other module, the push task (defined as the
// bundle loads, which is also how Android runs it with the app closed), then Expo Router.
import './src/boot';
import './src/push/background';
import 'expo-router/entry';
