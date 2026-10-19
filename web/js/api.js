// Small wrapper around the EasyMarkDoc server API.

const metaToken = document.querySelector('meta[name="emd-token"]')?.content;
export const token =
  metaToken && metaToken !== "__EMD_TOKEN__"
    ? metaToken
    : new URLSearchParams(location.search).get("token") || "";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Call an API endpoint. Returns parsed JSON, or the raw Response when
 * `raw` is set (used for PDF/HTML bodies).
 */
export async function api(path, { method = "GET", body, signal, raw = false } = {}) {
  const headers = { "X-EasyMarkDoc-Token": token };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (data.error) message = data.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(message, response.status);
  }
  return raw ? response : response.json();
}
