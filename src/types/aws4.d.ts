/**
 * Minimal type declaration for the aws4 package.
 * aws4 v1.13.x does not ship bundled TypeScript types.
 * @types/aws4 is intentionally NOT used per project constraints.
 */
declare module "aws4" {
  export interface Credentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }

  export interface Request {
    host?: string;
    hostname?: string;
    path?: string;
    method?: string;
    headers?: Record<string, string | string[]>;
    body?: string;
    service?: string;
    region?: string;
    signQuery?: boolean;
  }

  export function sign(request: Request, credentials?: Credentials): Request;
}
