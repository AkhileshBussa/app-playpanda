import BookingForm from "@/components/BookingForm";
import { getActivePriceVersion } from "@/lib/settings/priceVersion";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <BookingForm priceVersion={await getActivePriceVersion()} />;
}
