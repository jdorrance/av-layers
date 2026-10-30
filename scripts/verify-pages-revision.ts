import { pathToFileURL } from 'node:url';

export interface PagesRevisionOptions {
  url: string;
  expectedDeploymentId: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  delayMs?: number;
}

export function deploymentMarker(expectedDeploymentId: string): string {
  if (!/^[0-9a-f]{40}-\d{1,20}-\d{1,10}$/i.test(expectedDeploymentId)) throw new Error('EXPECTED_DEPLOYMENT_ID must be a commit SHA, run ID and run attempt');
  return `name="build-deployment" content="${expectedDeploymentId}"`;
}

export async function verifyPagesRevision(options: PagesRevisionOptions): Promise<void> {
  const marker = deploymentMarker(options.expectedDeploymentId);
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 3;
  const delay = options.delayMs ?? 5000;
  let last = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, delay));
    const response = await fetchImpl(options.url, { headers: { accept: 'text/html' } });
    if (!response.ok) {
      last = `status ${response.status}`;
      continue;
    }
    const html = await response.text();
    if (html.includes(marker)) return;
    last = 'served HTML does not contain the expected revision marker';
  }
  throw new Error(`Pages revision verification failed: ${last}`);
}

async function main(): Promise<void> {
  const url = process.env.PAGES_BASE_URL;
  const expectedDeploymentId = process.env.EXPECTED_DEPLOYMENT_ID;
  if (!url || !expectedDeploymentId) throw new Error('PAGES_BASE_URL and EXPECTED_DEPLOYMENT_ID are required');
  await verifyPagesRevision({ url: new URL('/', url).toString(), expectedDeploymentId });
  console.log(`verify-pages-revision: ${url} serves deployment ${expectedDeploymentId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`verify-pages-revision: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
