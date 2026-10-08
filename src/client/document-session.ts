export interface DocumentStamp { document: number; revision: number }
export class DocumentSession {
  private document = 0
  private revision = 0
  stamp(): DocumentStamp { return { document: this.document, revision: this.revision } }
  replace(): void { this.document += 1; this.revision = 0 }
  edit(): void { this.revision += 1 }
  sameDocument(stamp: DocumentStamp): boolean { return stamp.document === this.document }
  unchanged(stamp: DocumentStamp): boolean { return this.sameDocument(stamp) && stamp.revision === this.revision }
}
export function mintNodeId(kind: string, existing: readonly string[]): string {
  const used = new Set(existing)
  let counter = 1
  while (used.has(`${kind}_${counter}`)) counter += 1
  return `${kind}_${counter}`
}
