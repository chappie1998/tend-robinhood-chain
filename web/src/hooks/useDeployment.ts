import { useQuery } from "@tanstack/react-query";
import { loadDeploymentManifest, type DeploymentState } from "../deployment";

/**
 * Loads the Monad testnet deployment manifest (see deployment.ts). Always
 * resolves to a DeploymentState — loading, not-deployed, error, or ready —
 * never throws, so the caller never needs a try/catch.
 */
export function useDeployment(): DeploymentState {
  const query = useQuery({
    queryKey: ["deployment-manifest"],
    queryFn: loadDeploymentManifest,
    staleTime: Infinity,
    retry: false,
  });

  if (query.data) return query.data;
  if (query.isPending) return { status: "loading" };
  return { status: "error", message: query.error ? String(query.error) : "Unknown error loading deployment manifest." };
}
