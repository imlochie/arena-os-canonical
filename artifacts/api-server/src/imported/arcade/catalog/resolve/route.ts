import { catalogRequest } from "../../catalog-route";
export const POST = (req: Request) => catalogRequest(req, true);
