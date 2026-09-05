import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  adminCookieOptions,
  opsCookieOptions,
  verifyAdminPassword,
  verifyOpsPassword,
} from "@/lib/ops/auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let password = "";
  try {
    const body = await request.json();
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (!process.env.OPS_PASSWORD) {
    return NextResponse.json(
      { error: "OPS_PASSWORD is not configured on the server." },
      { status: 500 }
    );
  }

  const jar = await cookies();

  // The owner's password opens everything the counter's does, so it sets both
  // cookies — every existing isOpsAuthed() check keeps working untouched, and
  // only the owner-only views have to ask about the admin one.
  const adminCookie = verifyAdminPassword(password);
  if (adminCookie) {
    jar.set({ ...adminCookieOptions(), value: adminCookie });
    const opsCookie = verifyOpsPassword(process.env.OPS_PASSWORD);
    if (opsCookie) jar.set({ ...opsCookieOptions(), value: opsCookie });
    return NextResponse.json({ ok: true, admin: true });
  }

  const cookieValue = verifyOpsPassword(password);
  if (!cookieValue) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  // Typing the counter password after being admin must drop the owner tier —
  // otherwise handing the tablet back wouldn't take the money views away.
  jar.set({ ...adminCookieOptions(), value: "", maxAge: 0 });
  jar.set({ ...opsCookieOptions(), value: cookieValue });
  return NextResponse.json({ ok: true, admin: false });
}

export async function DELETE() {
  const jar = await cookies();
  jar.set({ ...opsCookieOptions(), value: "", maxAge: 0 });
  jar.set({ ...adminCookieOptions(), value: "", maxAge: 0 });
  return NextResponse.json({ ok: true });
}
