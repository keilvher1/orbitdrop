// DragSessionController — the helper's drag-session state machine.
//
// Pure logic: driven by abstract events (polled input observations, OLE drop
// target callbacks, protocol requests) and talking to the platform through the
// Host interface. The Win32 layer (src/win) feeds it; tests feed it scripted
// scenarios.
//
//   Idle → (button down) Pressed → (moved beyond SM_CXDRAG/SM_CYDRAG)
//   PotentialDrag [not announced] → (configured modifier combo held, stable) AwaitingPayload
//   [neutral wheel shown, centre fixed] → (OLE DragEnter) WheelActive [menu
//   chosen from the extension map, sector order frozen] → Drop on an enabled,
//   armed sector → `drop` sent, wheel hidden.
//
// Rules (shared with the macOS helper, docs/architecture.md):
//  * the wheel centre is fixed at activation (clamped to the monitor work area);
//  * the dead zone and the outside never select; a sector is selectable only
//    once armed (pointer moved armDistance from the activation point or passed
//    through the dead zone); disabled sectors are rejected;
//  * the drop effect is Copy only when the source allows DROPEFFECT_COPY,
//    otherwise None — never Move (Shift's default Move must not delete the source);
//  * exactly one `drop` per session; hover never commits; releasing the
//    modifier keeps an active wheel; DragLeave keeps the wheel for re-entry;
//    a polled button-up only cleans up (after a grace period when the pointer
//    is over the wheel, so a pending OLE Drop is never lost).
#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "core/coords.h"
#include "core/protocol.h"
#include "core/selection.h"

namespace od::session {

enum class Effect { None, Copy };

enum class PollMode { Off, Idle, Active };

enum class Phase { Idle, Pressed, PotentialDrag, AwaitingPayload, WheelActive, Cooldown };
const char* toString(Phase p);

/** One sample of the global input state (polled, no hooks). */
struct Observation {
    int64_t timeMs = 0;
    bool primaryDown = false;  // logical primary button (swapped buttons honoured by the caller)
    bool pointerValid = false;
    coords::PointI pointer;    // physical screen px
    uint8_t modifiers = 0;     // proto::ModifierBits
    bool escapeDown = false;
    bool suppressed = false;   // foreground thread is moving/sizing a window or in menu mode
    int32_t dragThresholdX = 4;  // SM_CXDRAG at the pointer's DPI
    int32_t dragThresholdY = 4;  // SM_CYDRAG
};

enum class CapsuleStyle { Normal, Active, Reject };

struct SectorVisual {
    std::string label;
    std::optional<proto::IconId> icon;
    bool enabled = false;
};

/** Everything the renderer needs to draw one frame of the wheel. */
struct RenderModel {
    geo::WheelGeometry geometry = geo::kDefaultGeometry;
    double diameter = 360;
    proto::WheelTokens tokens;
    bool highContrast = false;
    bool reduceMotion = false;
    proto::Locale locale = proto::Locale::Ko;

    proto::WheelMode mode = proto::WheelMode::Convert;
    bool neutral = true;       // AwaitingPayload: disc + capsule only
    bool unsupported = false;  // payload not offered: sectors greyed, capsule in reject style
    std::vector<SectorVisual> sectors;
    int highlight = -1;  // selectable sector under the pointer (drawn in sectorActive)
    int hover = -1;      // sector under the pointer that cannot be selected
    std::string capsuleText;
    CapsuleStyle capsuleStyle = CapsuleStyle::Normal;

    /** Same visible content (ignores appearance fields that cannot change within a session). */
    bool sameContent(const RenderModel& o) const;
};

/** Platform services used by the controller. */
class Host {
public:
    virtual ~Host() = default;
    /** Queue one protocol line (without '\n') for stdout. Must not block. */
    virtual void send(std::string line) = 0;
    /** Current monitors (Win32: EnumDisplayMonitors + GetDpiForMonitor). */
    virtual bool queryMonitors(std::vector<coords::Win32Monitor>& out) = 0;
    virtual void showWheel(const coords::WheelFrame& frame, const RenderModel& model) = 0;
    virtual void updateWheel(const RenderModel& model) = 0;
    virtual void hideWheel(bool animate) = 0;
    virtual void setPollMode(PollMode mode) = 0;
    /** Opaque id unique across helper instances (^[A-Za-z0-9_-]{1,64}$). */
    virtual std::string newSessionId() = 0;
    virtual void log(proto::LogLevel level, const std::string& message) = 0;
};

struct Tuning {
    int64_t activationStableMs = 40;   // combo held this long before the wheel shows / the mode switches
    int64_t dropGraceMs = 600;         // after a polled button-up over the wheel: wait for OLE Drop/DragLeave
    int64_t noDragTimeoutMs = 350;     // AwaitingPayload: no DragEnter although the pointer moved on the disc …
    double noDragMoveDip = 24;         // … this far → not an OLE drag (text selection, …): hide
    int64_t leaveReasonWindowMs = 1500;  // DragLeave on the disc then button-up within this → zone-specific reason
};

class Controller {
public:
    explicit Controller(Host& host, Tuning tuning = Tuning());

    /** New configuration. Sessions keep the configuration they started with;
     *  `enabled: false` cancels the current session (parentRequest). */
    void configure(std::shared_ptr<const proto::Configure> cfg);

    void tick(const Observation& o);

    /** OLE IDropTarget events. `copyAllowed` = (*pdwEffect & DROPEFFECT_COPY) on entry. */
    Effect dragEnter(const selection::DragPayload& payload, coords::PointI pointer, bool copyAllowed, int64_t nowMs);
    Effect dragOver(coords::PointI pointer, bool copyAllowed, int64_t nowMs);
    void dragLeave(bool pointerValid, coords::PointI pointer, int64_t nowMs);
    Effect drop(const selection::DragPayload& payload, coords::PointI pointer, bool copyAllowed, int64_t nowMs);

    /** True while a DragEnter should read the drag data (first entry of a session). */
    bool wantsPayload() const;

    /** main → helper cancelSession. */
    void cancelSession(const std::string& sessionId);
    /** Sleep, session lock, fatal errors. */
    void systemCancel(proto::CancelReason reason);
    /** Pause/resume observation (session locked, suspended). */
    void setSuspended(bool suspended);
    /** stdin EOF / shutdown: cancel (parentRequest) and hide. */
    void shutdown();

    Phase phase() const { return phase_; }
    const std::string& sessionId() const { return session_.id; }
    std::optional<proto::WheelMode> mode() const;
    const RenderModel& model() const { return model_; }
    const coords::WheelFrame& frame() const { return session_.frame; }
    bool enabled() const { return cfg_ && cfg_->enabled; }

private:
    struct Session {
        std::string id;
        std::shared_ptr<const proto::Configure> cfg;
        proto::WheelMode mode = proto::WheelMode::Convert;
        std::vector<coords::Win32Display> displays;
        coords::WheelFrame frame;
        geo::Point activationDip;
        bool armed = false;
        bool passedCenter = false;
        bool payloadKnown = false;
        selection::Classification cls;
        std::vector<proto::WheelSector> sectors;  // frozen for (session, mode)
        bool inside = false;                      // DragEnter without DragLeave/Drop
        bool hasHit = false;
        geo::WheelHit hit;
        bool copyAllowed = false;
        int64_t shownAt = 0;
        double awaitMoveDip = 0;
        bool awaitHasLast = false;
        coords::PointI awaitLast;
        bool ending = false;  // button-up seen while inside; waiting for Drop/DragLeave
        int64_t endingSince = 0;
        bool leftOnDisc = false;
        int64_t leftAt = 0;
        geo::WheelHit leaveHit;
        bool leaveArmed = false;
        bool leaveCopyAllowed = false;
        bool dropSent = false;
    };

    void startPotential(const Observation& o);
    void activate(const Observation& o, proto::WheelMode mode);
    void wheelTick(const Observation& o);
    void maybeSwitchMode(const Observation& o);
    void freezeSectors();
    void sendState(proto::SessionState state);
    void endWheel(std::optional<proto::CancelReason> reason, bool animate);
    void endPotential();
    void updateArming(coords::PointI pointer);
    geo::WheelHit hitAt(coords::PointI pointer) const;
    proto::CancelReason zoneReason(const geo::WheelHit& hit, bool armed, bool copyAllowed) const;
    Effect evaluate(coords::PointI pointer, bool copyAllowed);
    void refreshModel(bool push);
    std::string defaultCapsuleText() const;
    std::optional<proto::WheelMode> comboMode(uint8_t mods) const;
    void updatePollMode();

    Host& host_;
    Tuning tuning_;
    std::shared_ptr<const proto::Configure> cfg_;
    Phase phase_ = Phase::Idle;
    Session session_;
    RenderModel model_;
    bool suspended_ = false;
    bool lastPrimaryDown_ = false;
    coords::PointI pressPoint_;
    uint8_t heldMods_ = 0;
    bool heldGrew_ = false;  // the latest modifier change included a key press
    int64_t heldSince_ = 0;
    int64_t lastTime_ = 0;
    PollMode pollMode_ = PollMode::Off;
    bool pollModeSent_ = false;
};

}  // namespace od::session
