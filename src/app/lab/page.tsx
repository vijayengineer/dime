import { notFound } from "next/navigation";
import { Lab } from "./Lab";

/** Internal what-if tool. Dev server only: production builds return 404. */
export default function LabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Lab />;
}
