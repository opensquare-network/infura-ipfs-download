import { INFURA_IPFS_API, AUTH } from '../config.js';

/**
 * Call the Infura IPFS API with Basic auth. Defaults to POST.
 */
export async function infuraApi(endpoint, options = {}) {
  const url = `${INFURA_IPFS_API}${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    ...options,
    headers: {
      Authorization: `Basic ${AUTH}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Infura API error (${res.status}): ${endpoint}\n${body.slice(0, 500)}`,
    );
  }

  return res;
}
