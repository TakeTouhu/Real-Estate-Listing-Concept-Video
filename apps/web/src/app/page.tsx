import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { buildLiveness, buildReadiness } from "@/lib/health";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const liveness = buildLiveness();
  const readiness = await buildReadiness();

  return (
    <section>
      <h1>Operations console</h1>
      <p className="muted">Phase 0 authenticated health-check.</p>

      <div className="card">
        <h2>Liveness</h2>
        <dl>
          <dt>Status</dt>
          <dd className="status-ok">{liveness.status}</dd>
          <dt>Service</dt>
          <dd>{liveness.service}</dd>
          <dt>Version</dt>
          <dd>{liveness.version}</dd>
        </dl>
      </div>

      <div className="card">
        <h2>Readiness</h2>
        <dl>
          <dt>Status</dt>
          <dd className={readiness.status === "ready" ? "status-ok" : "status-bad"}>
            {readiness.status}
          </dd>
          <dt>Video provider</dt>
          <dd>{readiness.provider}</dd>
        </dl>
        <ul>
          {readiness.checks.map((check) => (
            <li key={check.name}>
              <span className={check.ok ? "status-ok" : "status-bad"}>
                {check.ok ? "PASS" : "FAIL"}
              </span>{" "}
              {check.name}
              {check.detail ? <span className="muted"> — {check.detail}</span> : null}
            </li>
          ))}
        </ul>
      </div>

      <form method="post" action="/api/auth/logout">
        <button type="submit">Sign out</button>
      </form>
    </section>
  );
}
