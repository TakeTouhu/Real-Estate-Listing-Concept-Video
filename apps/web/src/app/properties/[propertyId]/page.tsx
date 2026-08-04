import { redirect } from "next/navigation";
import { DEFAULT_UPLOAD_LIMITS, type MediaAsset } from "@app/domain";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { getPropertyServices } from "@/lib/property";
import { UploadPanel } from "./upload-panel";

export const dynamic = "force-dynamic";

function statusClass(status: MediaAsset["status"]): string {
  if (status === "READY") return "status-ok";
  if (status === "QUARANTINED" || status === "REJECTED" || status === "FAILED") return "status-bad";
  return "muted";
}

export default async function PropertyDetailPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { propertyId } = await params;

  // Resolve the property within one of the user's organizations.
  const organizations = await getIdentityServices().organizations.listForUser(current.user.id);
  const services = getPropertyServices();

  for (const { organization } of organizations) {
    let property;
    try {
      property = await services.properties.get(current.user.id, organization.id, propertyId);
    } catch {
      continue;
    }
    const assets = await services.assets.list(current.user.id, organization.id, propertyId);
    const used = assets.filter((a) => services.assets.countsTowardLimit(a)).length;
    const remaining = Math.max(DEFAULT_UPLOAD_LIMITS.maxAssetsPerProperty - used, 0);

    return (
      <section>
        <p className="muted">
          <a href="/">← Organizations</a>
        </p>
        <h1>{property.name}</h1>
        <p className="muted">
          {organization.name} · {property.propertyType}
          {property.addressMasked ? ` · ${property.addressMasked}` : ""}
        </p>
        {property.description ? <p>{property.description}</p> : null}
        <p>
          <a href={`/properties/${property.id}/review`}>Review photo analyses →</a>
        </p>
        <p>
          <a href={`/properties/${property.id}/video-projects`}>Videos →</a>
        </p>

        <UploadPanel
          organizationId={organization.id}
          propertyId={property.id}
          remainingSlots={remaining}
        />

        <div className="card">
          <h2>
            Photos <span className="muted">({used}/{DEFAULT_UPLOAD_LIMITS.maxAssetsPerProperty})</span>
          </h2>
          {assets.length === 0 ? (
            <p className="muted">No photos uploaded yet.</p>
          ) : (
            <ul>
              {assets.map((asset) => (
                <li key={asset.id}>
                  {asset.originalFilename} — <span className={statusClass(asset.status)}>{asset.status}</span>
                  {asset.width && asset.height ? (
                    <span className="muted">
                      {" "}
                      · {asset.width}×{asset.height}
                    </span>
                  ) : null}
                  {asset.failureReason ? (
                    <span className="status-bad"> · {asset.failureReason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="muted">
            Previews and downloads use short-lived signed links; photos are private and are never
            served from a public URL.
          </p>
        </div>
      </section>
    );
  }

  // Not found in any organization the user belongs to.
  redirect("/?error=Property%20not%20found");
}
