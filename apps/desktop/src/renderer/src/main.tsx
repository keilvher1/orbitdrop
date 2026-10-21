import './zod-jitless';
import './styles/base.css';
import { bootstrap } from './app/bootstrap';

// window.orbit is provided by the preload script (contextBridge). The renderer
// is sandboxed: no Node APIs, no remote resources, only this API.
const container = document.getElementById('root');
if (container !== null) {
  void bootstrap(container, (window as Partial<Window>).orbit);
}
