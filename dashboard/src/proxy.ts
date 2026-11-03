import { NextResponse, type NextRequest } from "next/server";
import { isUnlocked, LOCK_COOKIE } from "@/lib/lock";

// The optional dashboard password: when one is set, every request (pages and server actions) without the
// session cookie goes to /unlock.
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/unlock" || isUnlocked(request.cookies.get(LOCK_COOKIE)?.value)) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL("/unlock", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
