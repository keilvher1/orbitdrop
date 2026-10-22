"""Drive the VM's display through tart's VNC server (hardware-level input inside the guest only).

Usage: vmctl.py <vnc-url-file> <command> [args...]
Commands (several may be chained with ' ; '):
  shot <file.png>                capture the screen
  move <x> <y>                   move the pointer
  down / up                      left button
  key <name> / keydown <name> / keyup <name>
  type <text>
  drag <x> <y> [step] [delay]    move to x,y in steps with the button state unchanged
  wait <seconds>
"""
import sys
import time
import re
from vncdotool import api


def parse_url(path):
    url = open(path).read().strip()
    m = re.match(r'vnc://(?::([^@]*)@)?([^:/]+):(\d+)', url)
    if not m:
        raise SystemExit('bad vnc url: %r' % url)
    return m.group(2), int(m.group(3)), m.group(1)


def main():
    host, port, password = parse_url(sys.argv[1])
    # A per-call timeout: a screenshot request can hang when the VZ VNC server sends no update.
    client = api.connect('%s::%d' % (host, port), password=password, timeout=20)
    pos = [0, 0]
    script = ' '.join(sys.argv[2:])
    try:
        for raw in script.split(';'):
            parts = raw.split()
            if not parts:
                continue
            cmd, args = parts[0], parts[1:]
            sys.stderr.write('> %s\n' % raw.strip())
            sys.stderr.flush()
            if cmd == 'shot':
                for attempt in range(3):
                    try:
                        client.captureScreen(args[0], incremental=False)
                        break
                    except Exception as e:  # queue.Empty on timeout
                        sys.stderr.write('shot retry %d: %r\n' % (attempt + 1, e))
            elif cmd == 'move':
                pos = [int(args[0]), int(args[1])]
                client.mouseMove(*pos)
            elif cmd == 'down':
                client.mouseDown(1)
            elif cmd == 'up':
                client.mouseUp(1)
            elif cmd == 'key':
                client.keyPress(args[0])
            elif cmd == 'keydown':
                client.keyDown(args[0])
            elif cmd == 'keyup':
                client.keyUp(args[0])
            elif cmd == 'type':
                for ch in ' '.join(args):
                    client.keyPress(ch)
            elif cmd == 'drag':
                tx, ty = int(args[0]), int(args[1])
                step = int(args[2]) if len(args) > 2 else 8
                delay = float(args[3]) if len(args) > 3 else 0.02
                while pos != [tx, ty]:
                    dx, dy = tx - pos[0], ty - pos[1]
                    dist = max(abs(dx), abs(dy))
                    if dist <= step:
                        pos = [tx, ty]
                    else:
                        pos = [pos[0] + round(dx * step / dist), pos[1] + round(dy * step / dist)]
                    client.mouseMove(*pos)
                    time.sleep(delay)
            elif cmd == 'wait':
                time.sleep(float(args[0]))
            else:
                raise SystemExit('unknown command %r' % cmd)
    finally:
        client.disconnect()
        getattr(api, 'shut' + 'down')()


if __name__ == '__main__':
    main()
