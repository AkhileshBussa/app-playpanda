import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { opsCookieOptions, verifyOpsPassword } from "@/lib/ops/auth";

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

  const cookieValue = verifyOpsPassword(password);
  if (!cookieValue) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  (await cookies()).set({ ...opsCookieOptions(), value: cookieValue });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  (await cookies()).set({ ...opsCookieOptions(), value: "", maxAge: 0 });
  return NextResponse.json({ ok: true });
}
