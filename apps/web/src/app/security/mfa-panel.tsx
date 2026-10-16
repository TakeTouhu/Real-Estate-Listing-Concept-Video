"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  readonly enabled: boolean;
  /** The user's roles or permissions, or an organization, make MFA mandatory, so it cannot be turned off. */
  readonly required: boolean;
  readonly recoveryCodesLeft: number;
  /** This sign-in must set MFA up before anything else; once it has, it goes on in. */
  readonly mustSetUp?: boolean;
}

interface Setup {
  readonly secret: string;
  readonly qrCode: string;
}

/**
 * Set up, move or turn off authenticator-app MFA, and replace recovery codes
 * (ADR-0065). The server decides everything; this re-derives no rule. Secrets
 * and recovery codes live only in component state, and recovery codes are
 * shown once.
 */
export function MfaPanel({ enabled, required, recoveryCodesLeft, mustSetUp = false }: Props) {
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  /** POST to an MFA route; the body on success, or null with the error shown. */
  async function post(path: string, body?: { readonly code: string }): Promise<unknown> {
    setPending(true);
    setError("");
    try {
      const response = await fetch(path, {
        method: "POST",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401) {
        router.push("/login");
        return null;
      }
      if (!response.ok) {
        setError(await messageOf(response));
        return null;
      }
      return response.status === 204 ? {} : ((await response.json()) as unknown);
    } catch {
      setError("Something went wrong. Try again.");
      return null;
    } finally {
      setPending(false);
    }
  }

  async function startSetup(): Promise<void> {
    const result = (await post("/api/mfa/setup")) as Setup | null;
    if (result) {
      setCode("");
      setSetup(result);
    }
  }

  async function confirmSetup(): Promise<void> {
    const result = (await post("/api/mfa/setup/confirm", { code: code.trim() })) as {
      recoveryCodes: readonly string[];
    } | null;
    if (result) {
      setSetup(null);
      setCode("");
      setRecoveryCodes(result.recoveryCodes);
    }
  }

  async function replaceRecoveryCodes(): Promise<void> {
    const result = (await post("/api/mfa/recovery-codes")) as { recoveryCodes: readonly string[] } | null;
    if (result) setRecoveryCodes(result.recoveryCodes);
  }

  async function turnOff(): Promise<void> {
    if (await post("/api/mfa/disable", { code: code.trim() })) {
      setCode("");
      router.refresh();
    }
  }

  const errorLine = error ? (
    <p className="status-bad" role="alert">
      {error}
    </p>
  ) : null;

  if (recoveryCodes) {
    return (
      <div className="card">
        <h2>Your recovery codes</h2>
        <p>
          Save these somewhere safe. Each one signs you in once if you lose your authenticator app.
          They will not be shown again.
        </p>
        <ul aria-label="Recovery codes">
          {recoveryCodes.map((recoveryCode) => (
            <li key={recoveryCode}>
              <code>{recoveryCode}</code>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => {
            setRecoveryCodes(null);
            if (mustSetUp) router.push("/");
            else router.refresh();
          }}
        >
          I have saved them
        </button>
      </div>
    );
  }

  if (setup) {
    return (
      <div className="card">
        <h2>{enabled ? "Move to a new authenticator app" : "Set up an authenticator app"}</h2>
        <p>Scan this QR code with your authenticator app, or type in the key below.</p>
        <img src={setup.qrCode} alt="QR code for your authenticator app" width={200} height={200} />
        <p>
          Key: <code>{setup.secret}</code>
        </p>
        <CodeField value={code} onChange={setCode} />
        <button type="button" disabled={code.trim() === "" || pending} onClick={() => void confirmSetup()}>
          {enabled ? "Move MFA" : "Turn on MFA"}
        </button>{" "}
        <button type="button" disabled={pending} onClick={() => setSetup(null)}>
          Cancel
        </button>
        {errorLine}
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="card">
        <h2>Two-step sign-in (MFA)</h2>
        <p>MFA is off.{required ? " Your role or organization requires it." : ""}</p>
        <p className="muted">
          With MFA on, signing in also asks for a code from an authenticator app on your phone.
        </p>
        <button type="button" disabled={pending} onClick={() => void startSetup()}>
          Set up MFA
        </button>
        {errorLine}
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Two-step sign-in (MFA)</h2>
      <p className="status-ok">MFA is on.</p>
      <p>Recovery codes left: {recoveryCodesLeft}</p>
      <button type="button" disabled={pending} onClick={() => void replaceRecoveryCodes()}>
        New recovery codes
      </button>{" "}
      <button type="button" disabled={pending} onClick={() => void startSetup()}>
        Move to a new device
      </button>
      {required ? (
        <p className="muted">Your role or organization requires MFA, so it cannot be turned off.</p>
      ) : (
        <>
          <h3>Turn off MFA</h3>
          <CodeField value={code} onChange={setCode} />
          <button type="button" disabled={code.trim() === "" || pending} onClick={() => void turnOff()}>
            Turn off MFA
          </button>
        </>
      )}
      {errorLine}
    </div>
  );
}

function CodeField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span className="muted">Code from your authenticator app</span>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={value}
        aria-label="Code from your authenticator app"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/** The envelope's message, with the attempts left when the server counts them. */
async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown; details?: { attemptsLeft?: unknown } } };
    const message = typeof body.error?.message === "string" ? body.error.message : "Something went wrong";
    const left = body.error?.details?.attemptsLeft;
    return typeof left === "number" ? `${message}. Attempts left: ${left}` : message;
  } catch {
    return "Something went wrong. Try again.";
  }
}
