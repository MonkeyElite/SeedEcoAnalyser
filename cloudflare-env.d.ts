interface Fetcher {
  fetch(input: Request): Promise<Response>;
}

type D1Database = object;

declare module "cloudflare:workers" {
  export const env: { DB?: D1Database };
}
