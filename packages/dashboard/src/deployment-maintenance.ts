import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/* FNXC:DeploymentSafety 2026-09-04-07:39:
 * A staged upgrade must not accept operator writes before its data-preserving
 * acceptance transaction commits. The marker contains no secret; the controller
 * supplies a process-only capability for its reconciliation API requests.
 */
export function deploymentMaintenanceActive(): boolean {
  const marker = process.env.FUSION_DEPLOYMENT_MAINTENANCE_FILE;
  return !!marker && existsSync(marker);
}

export function deploymentMaintenance(req: Request, res: Response, next: NextFunction): void {
  if (!deploymentMaintenanceActive()) { next(); return; }
  // Only the exact liveness route is public during maintenance. GET handlers
  // elsewhere can have effects, so method-based exemptions are insufficient.
  if (req.method === "GET" && req.path === "/api/health") {
    res.setHeader("X-Fusion-Deployment-Fence", "1"); next(); return;
  }
  const expected = process.env.FUSION_DEPLOYMENT_CAPABILITY;
  const supplied = req.get("X-Fusion-Deployment-Capability");
  if (expected && supplied) {
    const a = Buffer.from(expected), b = Buffer.from(supplied);
    if (a.length === b.length && timingSafeEqual(a, b)) { next(); return; }
  }
  res.setHeader("Retry-After", "5");
  res.status(503).json({ error: "deployment-maintenance", retryable: true });
}
