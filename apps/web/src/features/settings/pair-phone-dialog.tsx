import { errorMessage } from '@superagent/client';
import type { TokenRecord } from '@superagent/shared';
import { CircleCheck, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useCreatePairing, useWithdrawPairing } from '../../api/settings';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { Notice, Spinner } from '../../ui/feedback';
import { Input } from '../../ui/field';
import { QrCode } from '../../ui/qr-code';
import { toast } from '../../ui/toast';

/** What the phone app opens: the server to talk to, and the code that signs it in. */
export function pairingLink(server: string, code: string): string {
  return `superagent://pair?server=${encodeURIComponent(server)}&code=${encodeURIComponent(code)}`;
}

/** "9:41", "0:05". */
function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * Pairs a phone (D53): a code made with the admin token, shown as a QR code and a link, which the app
 * claims for a device token of its own. The device list is polled meanwhile, so the dialog sees the
 * phone arrive.
 */
export function PairPhoneDialog({
  open,
  onOpenChange,
  adminToken,
  tokens,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adminToken: string | null;
  tokens: TokenRecord[] | undefined;
}) {
  const pairing = useCreatePairing(adminToken);
  const withdraw = useWithdrawPairing(adminToken);
  /** The tokens there were when the code was made: a new one is the phone. */
  const [before, setBefore] = useState<ReadonlySet<string> | null>(null);
  const now = useNow(open && pairing.isSuccess);
  const linkId = useId();

  const make = () => {
    setBefore(new Set((tokens ?? []).map((token) => token.id)));
    pairing.mutate();
  };
  /** A code was asked for since the dialog opened (effects may run twice in development). */
  const asked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a code is made when the dialog opens, once.
  useEffect(() => {
    if (!open || asked.current) return;
    asked.current = true;
    make();
  }, [open]);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      // The code is a credential until it's used: forget it with the dialog, and end it on the server.
      if (asked.current) withdraw.mutate();
      asked.current = false;
      pairing.reset();
      setBefore(null);
    }
  };

  const paired =
    pairing.isSuccess && before
      ? tokens?.find((token) => !before.has(token.id) && !token.revokedAt)
      : undefined;
  const left = pairing.data ? Date.parse(pairing.data.expiresAt) - now : 0;
  const link = pairing.data ? pairingLink(window.location.origin, pairing.data.code) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Copied');
    } catch {
      toast.error('Couldn’t copy', 'Select it and copy it by hand.');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={paired ? 'Phone paired' : 'Pair a phone'}
      description={
        paired
          ? undefined
          : 'Scan this with the superagent app on your phone. The code works once, for 10 minutes.'
      }
      footer={
        <Button variant="primary" onClick={() => close(false)}>
          Done
        </Button>
      }
    >
      {paired ? (
        <p className="flex items-center gap-2 pb-2 text-body text-foreground">
          <CircleCheck aria-hidden className="size-5 text-badge-green-foreground" />“{paired.name}” is signed
          in.
        </p>
      ) : pairing.isError ? (
        <div className="flex flex-col items-start gap-3 pb-2">
          <Notice tone="destructive" title="Couldn’t make a pairing code">
            {errorMessage(pairing.error)}
          </Notice>
          <Button onClick={make}>Try again</Button>
        </div>
      ) : !pairing.data ? (
        <p className="flex items-center gap-2 pb-2 text-body-sm text-muted-foreground">
          <Spinner /> Making a code…
        </p>
      ) : left <= 0 ? (
        <div className="flex flex-col items-start gap-3 pb-2">
          <p className="text-body-sm text-muted-foreground">This code has expired.</p>
          <Button variant="primary" onClick={make}>
            Make a new code
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4 pb-2">
          <div className="flex flex-col items-center gap-2">
            <QrCode value={link} label="Pairing code for the superagent app" className="size-56" />
            <p className="text-caption text-muted-foreground" aria-live="off">
              Expires in {countdown(left)}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={linkId} className="text-label text-foreground">
              Or open this link on the phone
            </label>
            <div className="flex items-center gap-2">
              <Input
                id={linkId}
                readOnly
                value={link}
                className="font-mono"
                onFocus={(event) => event.target.select()}
              />
              <Button onClick={() => void copy()}>
                <Copy aria-hidden />
                Copy
              </Button>
            </div>
            <p className="text-caption text-muted-foreground">
              On the Android emulator, copy it here and paste it into the app’s sign-in.
            </p>
          </div>
        </div>
      )}
    </Dialog>
  );
}
