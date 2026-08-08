import type { Metadata } from "next";
import FeedbackForm from "@/components/feedback/FeedbackForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — How was your visit?",
  description: "Tell us how your visit to Play Panda went.",
};

/**
 * PUBLIC customer feedback — the page behind the QR code at the counter.
 *
 * 5 stars are pointed at Google; anything less is asked what to improve and
 * kept here for the manager. Deliberately no auth and no ops chrome.
 */
export default function FeedbackPage() {
  return <FeedbackForm googleReviewUrl={process.env.NEXT_PUBLIC_GOOGLE_REVIEW_URL ?? ""} />;
}
