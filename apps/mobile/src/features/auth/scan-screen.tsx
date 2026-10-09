import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { parsePairingLink } from '../../api/pairing';
import { Button } from '../../ui/button';
import { Notice, Spinner } from '../../ui/feedback';
import { Text } from '../../ui/text';
import { makeStyles, radius, space } from '../../ui/theme';

/** The camera, looking for the pairing code the web app shows. It asks for the camera first. */
export function ScanScreen() {
  const styles = useStyles();
  const [permission, requestPermission] = useCameraPermissions();
  const [problem, setProblem] = useState<string | null>(null);
  const handled = useRef(false);

  const onScanned = ({ data }: BarcodeScanningResult) => {
    if (handled.current) return;
    const parsed = parsePairingLink(data);
    if (!parsed) {
      setProblem('That code isn’t a superagent pairing code.');
      return;
    }
    if ('error' in parsed) {
      setProblem(parsed.error);
      return;
    }
    handled.current = true;
    router.replace({ pathname: '/pair', params: { server: parsed.server, code: parsed.code } });
  };

  if (!permission) return <Spinner />;
  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.center}>
        <Text variant="heading" center>
          The camera, to scan the code
        </Text>
        <Text variant="bodySmall" color="mutedForeground" center>
          superagent uses it only here, to read the pairing code the web app shows.
        </Text>
        {permission.canAskAgain ? (
          <Button title="Allow the camera" variant="primary" onPress={() => void requestPermission()} />
        ) : (
          <Text variant="caption" color="mutedForeground" center>
            Turned off in the system settings. Paste the pairing link instead.
          </Text>
        )}
        <Button title="Back" variant="ghost" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.camera}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onScanned}
      />
      <SafeAreaView style={styles.overlay} edges={['top', 'bottom']}>
        <Text variant="label" center style={styles.hint}>
          Point the camera at the code on the Devices page.
        </Text>
        <View style={styles.frame} accessibilityElementsHidden />
        {problem ? <Notice tone="warning" title={problem} /> : null}
        <Button title="Cancel" onPress={() => router.back()} />
      </SafeAreaView>
    </View>
  );
}

const useStyles = makeStyles((theme) => ({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    padding: space.xl,
    backgroundColor: theme.colors.background,
  },
  camera: { flex: 1, backgroundColor: '#000' },
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: space.xl,
    gap: space.lg,
  },
  hint: { color: '#fff', marginTop: space.lg },
  frame: {
    width: 240,
    height: 240,
    borderRadius: radius.card,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.85)',
  },
}));
