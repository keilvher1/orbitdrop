import type { EngineProbe } from '@orbitdrop/contracts';
import { OrbitError } from '@orbitdrop/contracts';

// Placeholder: the processors-convert workstream measures real engine support here.
export async function probeEngines(): Promise<EngineProbe> {
  throw new OrbitError('ENGINE_UNAVAILABLE', 'probe not implemented yet');
}
