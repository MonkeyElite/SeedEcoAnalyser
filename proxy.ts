import { NextRequest, NextResponse } from "next/server";
import { authConfigurationError, sessionCookieName, verifySessionToken } from "./app/lib/auth";

function applySecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return response;
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const staticAsset = pathname.startsWith("/assets/") || pathname.startsWith("/_next/") || /\.(?:css|js|woff2?|png|webp|ico|svg)$/.test(pathname);
  if (staticAsset) return applySecurityHeaders(NextResponse.next());

  // Authentication is opt-in. A default Docker deployment remains usable
  // without secrets, matching the calculator's local-only, no-account model.
  if (authConfigurationError()) return applySecurityHeaders(NextResponse.next());

  const publicRoute = pathname === "/login" || pathname === "/api/auth/login";
  const token = request.cookies.get(sessionCookieName())?.value;
  const session = verifySessionToken(token);

  if (publicRoute) {
    if (session && pathname === "/login") return applySecurityHeaders(NextResponse.redirect(new URL("/", request.url)));
    return applySecurityHeaders(NextResponse.next());
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return applySecurityHeaders(NextResponse.json({ error: "Authentication required." }, { status: 401 }));
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("returnTo", `${pathname}${request.nextUrl.search}`);
    return applySecurityHeaders(NextResponse.redirect(loginUrl));
  }

  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Authenticated-User", session.username);
  return applySecurityHeaders(response);
}

export const config = {
  matcher: ["/:path*"],
};
