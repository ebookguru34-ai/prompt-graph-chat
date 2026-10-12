export type PortMap = Record<string, unknown>;
export interface GraphNode { id: string; type: string; x: number; y: number; config: Record<string, unknown>; }
export interface GraphEdge { id: string; from: string; fromPort: string; to: string; toPort: string; }
export interface Graph { version: 1; name: string; nodes: GraphNode[]; edges: GraphEdge[]; }
export interface NodeTrace { nodeId: string; label: string; inputs: PortMap; outputs: PortMap | null; durationMs: number; error?: string; skipped?: boolean; }
