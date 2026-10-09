import { Alert } from 'react-native';

/** Asks first: signing out revokes this phone's token. */
export function confirmSignOut(signOut: () => void): void {
  Alert.alert('Sign out?', 'This phone’s token is revoked. Pair it again to come back.', [
    { text: 'Stay signed in', style: 'cancel' },
    { text: 'Sign out', style: 'destructive', onPress: signOut },
  ]);
}
