import SpaceDetail from "@/components/SpaceDetail";

export const dynamic = "force-dynamic";

export default function SpacePage({ params }: { params: { id: string } }) {
  const { id } = params;
  return <SpaceDetail id={id} />;
}
