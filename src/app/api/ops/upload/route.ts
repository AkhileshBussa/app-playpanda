import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { isOpsAuthed } from "@/lib/ops/auth";
import { currentEmployeeId } from "@/lib/staff/auth";

export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/heic"];

/**
 * Photo upload for issue reports and expense bills → Vercel Blob.
 *
 * Blobs are public: the URL is unguessable, and it has to be readable by the
 * Swipe attachment viewer as well as our own pages. Don't send anything here
 * that shouldn't be world-readable-with-the-link.
 */
export async function POST(req: Request) {
  if (!(await isOpsAuthed()) && !(await currentEmployeeId())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const form = await req.formData();
    const entry = form.get("file");
    // `File` only became a Node global in v20, so `instanceof File` throws a
    // ReferenceError on anything older. Duck-type the upload instead — a Blob
    // is all `put` needs, and the filename is just a label.
    const file =
      entry && typeof entry !== "string" && typeof entry.arrayBuffer === "function"
        ? (entry as Blob & { name?: string })
        : null;
    if (!file) {
      return NextResponse.json({ error: "No file received" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "That photo is over 8 MB" }, { status: 413 });
    }
    if (!ALLOWED.includes(file.type)) {
      return NextResponse.json({ error: "Photos only (JPEG, PNG, WebP)" }, { status: 415 });
    }

    const folder = form.get("folder") === "expenses" ? "expenses" : "issues";
    const blob = await put(`${folder}/${file.name || "photo"}`, file, {
      access: "public",
      addRandomSuffix: true,
      contentType: file.type,
    });
    return NextResponse.json({ url: blob.url });
  } catch (err) {
    // Blob accepts either a read-write token OR OIDC + a store id, so the SDK
    // is the only thing that knows whether storage is usable. Sniffing one
    // specific env var here would reject a perfectly good OIDC setup.
    const message = err instanceof Error ? err.message : "";
    if (/no blob credentials|BLOB_READ_WRITE_TOKEN|BLOB_STORE_ID|oidc/i.test(message)) {
      console.error("blob not configured:", message);
      return NextResponse.json(
        { error: "Photo storage isn't set up — connect Vercel Blob to the project" },
        { status: 503 }
      );
    }
    console.error("upload failed:", err);
    return NextResponse.json({ error: "Upload failed — please retry" }, { status: 502 });
  }
}
