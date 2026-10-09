export class ManagerError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 503 | 504, message: string) {
    super(message);
  }
}

export const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const previewLabelPattern = /^ma-[a-z0-9]{8}$/;

export function validateProjectId(id: string): void {
  if (!projectIdPattern.test(id)) throw new ManagerError(400, "Invalid project UUID");
}
