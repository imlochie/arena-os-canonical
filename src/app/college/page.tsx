import CollegeStateView from "@/components/college/CollegeState";

export const metadata = {
  title: "Lochie Life College — Institutional State",
  description:
    "The College's current understanding of itself: academic position, scheduled vs observed reality, educational memory and institutional record.",
};

export const dynamic = "force-dynamic";

export default function CollegePage() {
  return <CollegeStateView />;
}
