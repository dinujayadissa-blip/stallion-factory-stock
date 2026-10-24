import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

// The one place the address lives. Change it here if the site ever moves.
const APP_URL = 'https://stallion-stock.pages.dev';

// Stallion colours
const ESPRESSO = '#201e16';
const OLIVE = '#6c724b';
const LIMESTONE = '#f1ebe1';

const hostOf = (url) => (/^https?:\/\/([^/:?#]+)/i.exec(url || '') || [])[1]?.toLowerCase();
const APP_HOST = hostOf(APP_URL);

// Offline check: any HTTP answer (even an error page) means we have signal;
// only a network failure or a 6-second silence counts as offline.
async function haveSignal() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    await fetch(APP_URL, { method: 'HEAD', signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default function App() {
  const webRef = useRef(null);
  const canGoBack = useRef(false);
  const [offline, setOffline] = useState(false);
  const [checking, setChecking] = useState(true);
  const [loadKey, setLoadKey] = useState(0); // bumping this remounts the WebView

  const check = useCallback(async () => {
    setChecking(true);
    const ok = await haveSignal();
    setOffline(!ok);
    if (ok) setLoadKey((k) => k + 1);
    setChecking(false);
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  // Android back button: go back inside the site first, exit only from the first page.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!offline && canGoBack.current && webRef.current) {
        webRef.current.goBack();
        return true;
      }
      return false; // let the system exit the app
    });
    return () => sub.remove();
  }, [offline]);

  // Links that leave the Stallion site open in the phone's browser.
  const onShouldStartLoadWithRequest = useCallback((req) => {
    const url = req.url || '';
    if (url === 'about:blank' || url.startsWith('blob:') || url.startsWith('data:')) return true;
    if (hostOf(url) === APP_HOST) return true;
    Linking.openURL(url).catch(() => {});
    return false;
  }, []);

  const showOffline = offline || checking;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
        <StatusBar style="light" backgroundColor={ESPRESSO} />
        {showOffline ? (
          <View style={styles.offline}>
            <Text style={styles.offlineText}>Waiting for signal…</Text>
            {!checking && (
              <Pressable
                style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
                onPress={check}
                accessibilityRole="button"
              >
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <WebView
            key={loadKey}
            ref={webRef}
            source={{ uri: APP_URL }}
            style={styles.web}
            sharedCookiesEnabled
            domStorageEnabled
            javaScriptEnabled
            allowFileAccess
            mediaPlaybackRequiresUserAction={false}
            setSupportMultipleWindows={false}
            startInLoadingState={false}
            onNavigationStateChange={(nav) => {
              canGoBack.current = nav.canGoBack;
            }}
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
            onError={() => setOffline(true)}
            onHttpError={() => {}}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: ESPRESSO },
  web: { flex: 1, backgroundColor: ESPRESSO },
  offline: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ESPRESSO,
    padding: 24,
  },
  offlineText: { color: LIMESTONE, fontSize: 20, marginBottom: 24 },
  retry: {
    backgroundColor: OLIVE,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 8,
  },
  retryPressed: { opacity: 0.8 },
  retryText: { color: LIMESTONE, fontSize: 16, fontWeight: '600' },
});
