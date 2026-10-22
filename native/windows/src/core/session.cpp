#include "core/session.h"

#include <cstdlib>
#include <utility>

#include "core/jsmath.h"

namespace od::session {

const char* toString(Phase p) {
    switch (p) {
        case Phase::Idle: return "Idle";
        case Phase::Pressed: return "Pressed";
        case Phase::PotentialDrag: return "PotentialDrag";
        case Phase::AwaitingPayload: return "AwaitingPayload";
        case Phase::WheelActive: return "WheelActive";
        case Phase::Cooldown: return "Cooldown";
    }
    return "?";
}

bool RenderModel::sameContent(const RenderModel& o) const {
    if (mode != o.mode || neutral != o.neutral || unsupported != o.unsupported || highlight != o.highlight ||
        hover != o.hover || capsuleText != o.capsuleText || capsuleStyle != o.capsuleStyle ||
        captionText != o.captionText || captionStyle != o.captionStyle || sectors.size() != o.sectors.size() ||
        diameter != o.diameter) {
        return false;
    }
    for (size_t i = 0; i < sectors.size(); ++i) {
        if (sectors[i].label != o.sectors[i].label || sectors[i].icon != o.sectors[i].icon ||
            sectors[i].enabled != o.sectors[i].enabled) {
            return false;
        }
    }
    return true;
}

Controller::Controller(Host& host, Tuning tuning) : host_(host), tuning_(tuning) {}

// ------------------------------------------------------------------ configuration

void Controller::configure(std::shared_ptr<const proto::Configure> cfg) {
    cfg_ = std::move(cfg);
    if (!enabled()) {
        if (phase_ == Phase::AwaitingPayload || phase_ == Phase::WheelActive) {
            endWheel(proto::CancelReason::ParentRequest, false);
        } else if (phase_ == Phase::PotentialDrag) {
            endPotential();
        }
        phase_ = Phase::Idle;
    }
    updatePollMode();
}

namespace {
/** Exact modifier-set match; convert wins if both combos are configured identically. */
std::optional<proto::WheelMode> comboModeFor(const proto::Configure* cfg, uint8_t mods) {
    if (cfg == nullptr) return std::nullopt;
    if (mods == cfg->convertModifiers) return proto::WheelMode::Convert;
    if (mods == cfg->toolsModifiers) return proto::WheelMode::Tools;
    return std::nullopt;
}
}  // namespace

std::optional<proto::WheelMode> Controller::comboMode(uint8_t mods) const { return comboModeFor(cfg_.get(), mods); }

std::optional<proto::WheelMode> Controller::mode() const {
    if (phase_ == Phase::AwaitingPayload || phase_ == Phase::WheelActive) return session_.mode;
    return std::nullopt;
}

void Controller::updatePollMode() {
    PollMode m;
    if (!enabled() || suspended_) {
        m = PollMode::Off;
    } else if (lastPrimaryDown_ || phase_ != Phase::Idle) {
        m = PollMode::Active;
    } else {
        m = PollMode::Idle;
    }
    if (!pollModeSent_ || m != pollMode_) {
        pollMode_ = m;
        pollModeSent_ = true;
        host_.setPollMode(m);
    }
}

// ------------------------------------------------------------------ polling

void Controller::tick(const Observation& o) {
    lastTime_ = o.timeMs;
    if (o.modifiers != heldMods_) {
        heldGrew_ = (o.modifiers & static_cast<uint8_t>(~heldMods_)) != 0;  // a key was pressed (not only released)
        heldMods_ = o.modifiers;
        heldSince_ = o.timeMs;
    }
    if (!enabled() || suspended_) {
        lastPrimaryDown_ = o.primaryDown;
        updatePollMode();
        return;
    }

    switch (phase_) {
        case Phase::Idle:
            if (o.primaryDown && o.pointerValid) {
                phase_ = Phase::Pressed;
                pressPoint_ = o.pointer;
                pressTime_ = o.timeMs;
                // A combo already held at the press does not count (Shift + text
                // selection, Shift + marquee): it is the baseline, not a key press.
                heldMods_ = o.modifiers;
                heldSince_ = o.timeMs;
                heldGrew_ = false;
            }
            break;
        case Phase::Pressed:
            if (!o.primaryDown) {
                phase_ = Phase::Idle;
            } else if (o.escapeDown) {
                phase_ = Phase::Cooldown;
            } else if (o.pointerValid) {
                const int64_t dx = std::llabs(static_cast<int64_t>(o.pointer.x) - pressPoint_.x);
                const int64_t dy = std::llabs(static_cast<int64_t>(o.pointer.y) - pressPoint_.y);
                // The drag rectangle is SM_CXDRAG × SM_CYDRAG centred on the press point.
                if (2 * dx > o.dragThresholdX || 2 * dy > o.dragThresholdY) {
                    if (o.suppressed) {
                        phase_ = Phase::Cooldown;  // a window move/resize or menu tracking, not a file drag
                    } else {
                        startPotential(o);
                    }
                }
            }
            break;
        case Phase::PotentialDrag:
            if (!o.primaryDown) {
                endPotential();
                phase_ = Phase::Idle;
            } else if (o.escapeDown || o.suppressed) {
                endPotential();
                phase_ = Phase::Cooldown;
            } else if (o.pointerValid && heldGrew_ && heldSince_ > pressTime_ &&
                       o.timeMs - heldSince_ >= tuning_.activationStableMs) {
                // The combo must be completed by a key press after the button
                // press (as on macOS), then held stable for activationStableMs.
                if (const auto m = comboMode(heldMods_)) activate(o, *m);
            }
            break;
        case Phase::AwaitingPayload:
        case Phase::WheelActive:
            wheelTick(o);
            break;
        case Phase::Cooldown:
            if (!o.primaryDown) phase_ = Phase::Idle;
            break;
    }
    lastPrimaryDown_ = o.primaryDown;
    updatePollMode();
}

void Controller::startPotential(const Observation& o) {
    (void)o;
    // A candidate is not announced to main (every text selection would be):
    // the session id is allocated and reported when the wheel appears.
    session_ = Session();
    phase_ = Phase::PotentialDrag;
}

void Controller::endPotential() { session_ = Session(); }

void Controller::activate(const Observation& o, proto::WheelMode mode) {
    std::vector<coords::Win32Monitor> monitors;
    if (!host_.queryMonitors(monitors) || monitors.empty()) {
        host_.log(proto::LogLevel::Warn, "no monitors; wheel not shown");
        endPotential();
        phase_ = Phase::Cooldown;
        return;
    }
    session_.displays = coords::displaysFromWin32Monitors(monitors);
    session_.frame = coords::computeWheelFrame(o.pointer, session_.displays, cfg_->geometry);
    if (!session_.frame.valid) {
        host_.log(proto::LogLevel::Warn, "wheel placement failed");
        endPotential();
        phase_ = Phase::Cooldown;
        return;
    }
    session_.id = host_.newSessionId();
    if (!proto::isValidId(session_.id)) {
        host_.log(proto::LogLevel::Error, "invalid session id from host");
        endPotential();
        phase_ = Phase::Cooldown;
        return;
    }
    session_.cfg = cfg_;
    session_.mode = mode;
    session_.activationDip = session_.frame.activationDip;
    session_.armed = false;
    session_.passedCenter = false;
    session_.shownAt = o.timeMs;
    phase_ = Phase::AwaitingPayload;
    updateArming(o.pointer);
    sendState(proto::SessionState::AwaitingPayload);
    refreshModel(false);
    host_.showWheel(session_.frame, model_);
}

void Controller::wheelTick(const Observation& o) {
    if (o.escapeDown) {
        endWheel(proto::CancelReason::Escape, true);
        phase_ = o.primaryDown ? Phase::Cooldown : Phase::Idle;
        return;
    }
    if (o.pointerValid) updateArming(o.pointer);

    if (session_.ending) {
        if (o.primaryDown) {
            // A new press while still waiting for the OLE drop: the old drag is over.
            endWheel(proto::CancelReason::DragEnded, true);
            phase_ = Phase::Idle;  // the next tick treats the held button as a fresh press
            return;
        }
        if (o.timeMs - session_.endingSince >= tuning_.dropGraceMs) {
            endWheel(proto::CancelReason::DragEnded, true);
            phase_ = Phase::Idle;
        }
        return;
    }

    if (!o.primaryDown) {
        if (phase_ == Phase::WheelActive && session_.inside) {
            // The OLE Drop (or DragLeave for a refused drop) for this release may
            // still be on its way from the source process. Wait for it.
            session_.ending = true;
            session_.endingSince = o.timeMs;
            return;
        }
        proto::CancelReason reason = proto::CancelReason::DragEnded;
        if (phase_ == Phase::WheelActive && session_.leftOnWheel && o.timeMs - session_.leftAt <= tuning_.leaveReasonWindowMs) {
            reason = zoneReason(session_.leaveHit, session_.leaveArmed, session_.leaveCopyAllowed);
        }
        endWheel(reason, true);
        phase_ = Phase::Idle;
        return;
    }

    maybeSwitchMode(o);

    if (phase_ == Phase::AwaitingPayload && o.pointerValid) {
        // Without hooks there is no global "an OLE drag is running" signal. Over a
        // visible registered drop target a real OLE drag always produces
        // DragEnter on the next move; if the pointer keeps moving on the disc and
        // none arrives, this is a text selection / ink stroke etc.: back off.
        const geo::Point local = coords::localDipOfScreenPixel(o.pointer, session_.frame);
        const bool onDisc = jsmath::hypot(local.x, local.y) <= geo::outerRadius(session_.frame.diameter);
        if (onDisc && session_.awaitHasLast) {
            const geo::Point prev = coords::localDipOfScreenPixel(session_.awaitLast, session_.frame);
            session_.awaitMoveDip += jsmath::hypot(local.x - prev.x, local.y - prev.y);
        }
        session_.awaitLast = o.pointer;
        session_.awaitHasLast = onDisc;
        if (session_.awaitMoveDip >= tuning_.noDragMoveDip && o.timeMs - session_.shownAt >= tuning_.noDragTimeoutMs) {
            host_.log(proto::LogLevel::Debug, "no OLE DragEnter while moving over the wheel; not a file drag");
            endWheel(proto::CancelReason::InvalidPayload, true);
            phase_ = Phase::Cooldown;
        }
    }
}

void Controller::maybeSwitchMode(const Observation& o) {
    // A key *press* that completes the other mode's combo switches the wheel
    // (Shift → Alt+Shift opens tools; releasing everything and pressing Shift
    // again returns to convert). Releases never switch, so the release order of
    // a chord cannot flip an open wheel. Same rule as the macOS helper.
    if (!heldGrew_ || o.timeMs - heldSince_ < tuning_.activationStableMs) return;
    const auto target = comboModeFor(session_.cfg.get(), heldMods_);
    if (!target || *target == session_.mode) return;
    session_.mode = *target;
    // Sector order is frozen per (session, mode); arming restarts so the new
    // sectors under the pointer cannot be selected by accident.
    session_.armed = false;
    session_.passedCenter = false;
    if (o.pointerValid) session_.activationDip = coords::pointerDip(o.pointer, session_.frame);
    if (session_.payloadKnown) freezeSectors();
    session_.hasHit = false;
    if (o.pointerValid) updateArming(o.pointer);
    sendState(phase_ == Phase::WheelActive ? proto::SessionState::WheelActive : proto::SessionState::AwaitingPayload);
    refreshModel(true);
}

void Controller::freezeSectors() {
    session_.sectors.clear();
    if (!session_.cls.supported || !session_.cls.menuKey) return;
    const proto::HelperMenu* menu = session_.cfg->findMenu(*session_.cls.menuKey);
    if (menu == nullptr) return;
    session_.sectors =
        selection::adjustForFileCount(menu->sectors(session_.mode), session_.cls.fileCount, session_.cfg->strings.multiFileUnsupported);
}

void Controller::sendState(proto::SessionState state) {
    proto::StateMessage m;
    m.sessionId = session_.id;
    m.state = state;
    if (state == proto::SessionState::AwaitingPayload || state == proto::SessionState::WheelActive) m.mode = session_.mode;
    if (state == proto::SessionState::WheelActive) {
        m.hasMenuKey = true;
        m.menuKey = session_.cls.menuKey;
        m.fileCount = static_cast<int64_t>(session_.cls.fileCount);
    }
    const std::string line = proto::serializeState(m);
    if (!line.empty()) host_.send(line);
}

void Controller::endWheel(std::optional<proto::CancelReason> reason, bool animate) {
    if (reason && !session_.id.empty()) {
        const std::string line = proto::serializeCancelled(session_.id, *reason);
        if (!line.empty()) host_.send(line);
    }
    host_.hideWheel(animate && !(session_.cfg && session_.cfg->reduceMotion));
    session_ = Session();
}

// ------------------------------------------------------------------ geometry helpers

geo::WheelHit Controller::hitAt(coords::PointI pointer) const {
    const geo::Point local = coords::localDipOfScreenPixel(pointer, session_.frame);
    return geo::hitTestWheel(local.x, local.y, static_cast<double>(session_.sectors.size()), session_.frame.diameter,
                             session_.cfg->geometry);
}

void Controller::updateArming(coords::PointI pointer) {
    if (!session_.cfg) return;
    const geo::Point local = coords::localDipOfScreenPixel(pointer, session_.frame);
    if (jsmath::hypot(local.x, local.y) <= geo::innerRadius(session_.frame.diameter, session_.cfg->geometry)) {
        session_.passedCenter = true;
    }
    const geo::Point p = coords::pointerDip(pointer, session_.frame);
    // geometry.ts isArmed, evaluated for the current pointer; passing through the
    // dead zone latches (passedCenter), distance from the activation point does not.
    session_.armed = geo::isArmed(session_.activationDip, p, session_.passedCenter, session_.cfg->geometry);
}

proto::CancelReason Controller::zoneReason(const geo::WheelHit& hit, bool armed, bool copyAllowed) const {
    if (!session_.cls.supported || session_.sectors.empty()) return proto::CancelReason::InvalidPayload;
    if (hit.zone != geo::WheelHit::Zone::Sector || hit.index < 0 ||
        static_cast<size_t>(hit.index) >= session_.sectors.size()) {
        return proto::CancelReason::OutsideRing;
    }
    const proto::WheelSector& s = session_.sectors[static_cast<size_t>(hit.index)];
    if (!s.enabled) return proto::CancelReason::DisabledSector;
    if (!armed) return proto::CancelReason::OutsideRing;
    if (!copyAllowed) return proto::CancelReason::InvalidPayload;
    return proto::CancelReason::DragEnded;
}

// ------------------------------------------------------------------ OLE events

bool Controller::wantsPayload() const { return phase_ == Phase::AwaitingPayload; }

void Controller::fileInfo(const std::string& sessionId, const selection::PathFacts& facts) {
    if (phase_ != Phase::WheelActive || session_.id.empty() || session_.id != sessionId || !session_.payloadKnown) return;
    // A folder wins over a cloud placeholder. A placeholder only changes a drag
    // that is otherwise offered (an unknown type stays plain "unsupported"); a
    // folder also gives an extensionless folder its own wording.
    const selection::Unsupported reason = facts.containsDirectory          ? selection::Unsupported::Directory
                                          : facts.containsCloudPlaceholder ? selection::Unsupported::CloudPlaceholder
                                                                           : selection::Unsupported::None;
    if (reason == selection::Unsupported::None || session_.cls.reason == reason) return;
    if (reason == selection::Unsupported::CloudPlaceholder && !session_.cls.supported) return;
    const bool wasSupported = session_.cls.supported;
    session_.cls.supported = false;
    session_.cls.reason = reason;
    session_.cls.menuKey.reset();
    freezeSectors();  // no sectors for an unsupported payload
    if (wasSupported) sendState(proto::SessionState::WheelActive);  // menuKey is now null
    refreshModel(true);
}

void Controller::displaysChanged(const std::vector<coords::Win32Monitor>& monitors) {
    if (phase_ != Phase::AwaitingPayload && phase_ != Phase::WheelActive) return;
    // The wheel's placement and hit-testing use its monitor's physical bounds
    // and DPI captured at activation; if those changed or the monitor is gone,
    // the window no longer matches what is on screen.
    const coords::Win32Display& d = session_.frame.display;
    bool same = false;
    for (const coords::Win32Monitor& m : monitors) {
        if (!d.id.empty() && m.id != d.id) continue;
        const geo::Rect& b = m.bounds;
        if (b.x == d.physicalBounds.x && b.y == d.physicalBounds.y && b.width == d.physicalBounds.width &&
            b.height == d.physicalBounds.height && m.dpi == d.dpi) {
            same = true;
            break;
        }
    }
    if (same) return;
    host_.log(proto::LogLevel::Info, "the wheel's monitor changed; session cancelled");
    endWheel(proto::CancelReason::Error, false);
    phase_ = lastPrimaryDown_ ? Phase::Cooldown : Phase::Idle;
    updatePollMode();
}

Effect Controller::dragEnter(const selection::DragPayload& payload, coords::PointI pointer, bool copyAllowed, int64_t nowMs) {
    lastTime_ = nowMs;
    if (phase_ == Phase::AwaitingPayload) {
        session_.cls = selection::classify(payload, *session_.cfg);
        session_.payloadKnown = true;
        freezeSectors();
        phase_ = Phase::WheelActive;
        sendState(proto::SessionState::WheelActive);
        if (!session_.cls.supported) {
            host_.log(proto::LogLevel::Debug, std::string("drag payload not offered: ") + selection::toString(session_.cls.reason));
        }
        // Folders and cloud-only placeholders can only be told apart with a
        // file-system call, which must not run inside DragEnter: ask the host to
        // check off the UI thread. Only worth it when the answer would change
        // the outcome or the wording.
        if (session_.cls.reason == selection::Unsupported::None || session_.cls.reason == selection::Unsupported::UnknownType) {
            host_.checkPaths(session_.id, payload.paths);
        }
    } else if (phase_ != Phase::WheelActive) {
        return Effect::None;
    }
    session_.inside = true;
    session_.leftOnWheel = false;
    return evaluate(pointer, copyAllowed);
}

Effect Controller::dragOver(coords::PointI pointer, bool copyAllowed, int64_t nowMs) {
    lastTime_ = nowMs;
    if (phase_ != Phase::WheelActive) return Effect::None;
    session_.inside = true;
    return evaluate(pointer, copyAllowed);
}

Effect Controller::evaluate(coords::PointI pointer, bool copyAllowed) {
    session_.copyAllowed = copyAllowed;
    updateArming(pointer);
    session_.hit = hitAt(pointer);
    session_.hasHit = true;
    refreshModel(true);
    if (!session_.cls.supported || session_.sectors.empty()) return Effect::None;
    if (session_.hit.zone != geo::WheelHit::Zone::Sector) return Effect::None;
    const proto::WheelSector& s = session_.sectors[static_cast<size_t>(session_.hit.index)];
    return (s.enabled && session_.armed && copyAllowed) ? Effect::Copy : Effect::None;
}

void Controller::dragLeave(bool pointerValid, coords::PointI pointer, int64_t nowMs, bool onCaption) {
    lastTime_ = nowMs;
    if (phase_ != Phase::WheelActive) return;
    session_.inside = false;
    session_.hasHit = false;
    session_.leftOnWheel = false;
    if (pointerValid) {
        updateArming(pointer);
        const geo::WheelHit hit = hitAt(pointer);
        const geo::Point local = coords::localDipOfScreenPixel(pointer, session_.frame);
        if (onCaption || jsmath::hypot(local.x, local.y) <= geo::outerRadius(session_.frame.diameter)) {
            // Still on the window's hit shape (the disc, or the caption pill,
            // which counts as outside the ring): OLE left us because the drag
            // ended (refused release or Esc), not because the pointer moved away.
            session_.leftOnWheel = true;
            session_.leftAt = nowMs;
            session_.leaveHit = hit;
            session_.leaveArmed = session_.armed;
            session_.leaveCopyAllowed = session_.copyAllowed;
        }
    }
    if (session_.ending) {
        const proto::CancelReason reason = session_.leftOnWheel
                                               ? zoneReason(session_.leaveHit, session_.leaveArmed, session_.leaveCopyAllowed)
                                               : proto::CancelReason::DragEnded;
        endWheel(reason, true);
        phase_ = lastPrimaryDown_ ? Phase::Cooldown : Phase::Idle;
        updatePollMode();
        return;
    }
    refreshModel(true);  // clear highlight, keep the wheel for re-entry
}

Effect Controller::drop(const selection::DragPayload& payload, coords::PointI pointer, bool copyAllowed, int64_t nowMs) {
    lastTime_ = nowMs;
    if (phase_ != Phase::WheelActive || session_.dropSent) return Effect::None;
    session_.inside = false;

    const auto finish = [&](std::optional<proto::CancelReason> reason) {
        endWheel(reason, true);
        phase_ = lastPrimaryDown_ ? Phase::Cooldown : Phase::Idle;
        updatePollMode();
    };

    // The data object is only valid during this call: work on the copy made now.
    const selection::Classification now = selection::classify(payload, *session_.cfg);
    if (!now.supported || !session_.cls.supported || now.menuKey != session_.cls.menuKey || now.fileCount != session_.cls.fileCount) {
        finish(proto::CancelReason::InvalidPayload);
        return Effect::None;
    }
    updateArming(pointer);
    const geo::WheelHit hit = hitAt(pointer);
    if (hit.zone != geo::WheelHit::Zone::Sector) {
        finish(proto::CancelReason::OutsideRing);
        return Effect::None;
    }
    const proto::WheelSector& sector = session_.sectors[static_cast<size_t>(hit.index)];
    if (!sector.enabled) {
        finish(proto::CancelReason::DisabledSector);
        return Effect::None;
    }
    if (!session_.armed) {
        finish(proto::CancelReason::OutsideRing);
        return Effect::None;
    }
    if (!copyAllowed) {
        finish(proto::CancelReason::InvalidPayload);
        return Effect::None;
    }
    proto::DropMessage m;
    m.sessionId = session_.id;
    m.actionId = sector.actionId;
    m.mode = session_.mode;
    m.files = payload.paths;
    const std::string line = proto::serializeDrop(m);
    if (line.empty()) {
        finish(proto::CancelReason::InvalidPayload);
        return Effect::None;
    }
    session_.dropSent = true;
    host_.send(line);
    finish(std::nullopt);
    return Effect::Copy;
}

// ------------------------------------------------------------------ external cancels

void Controller::cancelSession(const std::string& sessionId) {
    if (session_.id.empty() || session_.id != sessionId) return;
    if (phase_ == Phase::AwaitingPayload || phase_ == Phase::WheelActive) {
        endWheel(proto::CancelReason::ParentRequest, true);
    } else {
        return;  // candidates are unannounced, so main cannot name them
    }
    phase_ = lastPrimaryDown_ ? Phase::Cooldown : Phase::Idle;
    updatePollMode();
}

void Controller::systemCancel(proto::CancelReason reason) {
    if (phase_ == Phase::AwaitingPayload || phase_ == Phase::WheelActive) {
        endWheel(reason, false);
    } else if (phase_ == Phase::PotentialDrag) {
        endPotential();  // unannounced: nothing to report
    } else {
        return;
    }
    phase_ = lastPrimaryDown_ ? Phase::Cooldown : Phase::Idle;
    updatePollMode();
}

void Controller::setSuspended(bool suspended) {
    if (suspended == suspended_) return;
    if (suspended) systemCancel(proto::CancelReason::Sleep);
    suspended_ = suspended;
    if (suspended) phase_ = Phase::Idle;
    lastPrimaryDown_ = false;
    updatePollMode();
}

void Controller::shutdown() {
    systemCancel(proto::CancelReason::ParentRequest);
    host_.hideWheel(false);
    cfg_.reset();
    phase_ = Phase::Idle;
    updatePollMode();
}

// ------------------------------------------------------------------ render model

const char* cloudPlaceholderText(proto::Locale locale) {
    // Used when configure has no strings.unsupportedCloud; same advice as
    // main's CLOUD_PLACEHOLDER error.
    return locale == proto::Locale::Ko ? "\xEB\xA8\xBC\xEC\xA0\x80 \xEB\x82\xB4\xEB\xA0\xA4\xEB\xB0\x9B\xEC\x9C\xBC\xEC\x84\xB8\xEC\x9A\x94"  // 먼저 내려받으세요
                                       : "Download it first";
}

std::string Controller::defaultCapsuleText() const {
    const proto::Configure& c = *session_.cfg;
    if (session_.cls.fileCount > 1) {
        std::string t = c.strings.fileCount;
        const std::string n = std::to_string(session_.cls.fileCount);
        const size_t at = t.find("{n}");
        if (at != std::string::npos) t.replace(at, 3, n);
        return t;
    }
    if (session_.cls.menuKey) {
        const char* label = proto::formatLabelOfKey(*session_.cls.menuKey);
        if (label[0] != '\0') return label;
    }
    return c.strings.dropHint;
}

void Controller::refreshModel(bool push) {
    if (!session_.cfg) return;
    const proto::Configure& c = *session_.cfg;
    RenderModel m;
    m.geometry = c.geometry;
    m.diameter = session_.frame.diameter;
    m.tokens = c.tokens;
    m.highContrast = c.highContrast;
    m.reduceMotion = c.reduceMotion;
    m.locale = c.locale;
    m.mode = session_.mode;
    if (phase_ == Phase::AwaitingPayload) {
        m.neutral = true;
        m.capsuleText = c.strings.dropHint;
        m.capsuleStyle = CapsuleStyle::Normal;
    } else {
        m.neutral = false;
        m.unsupported = !session_.cls.supported || session_.sectors.empty();
        for (const proto::WheelSector& s : session_.sectors) {
            m.sectors.push_back(SectorVisual{s.label, s.icon, s.enabled && !m.unsupported});
        }
        if (m.unsupported) {
            // The specific wording when configure provides it, else the generic text.
            const std::optional<std::string>* specific = nullptr;
            switch (session_.cls.reason) {
                case selection::Unsupported::Directory: specific = &c.strings.unsupportedFolder; break;
                case selection::Unsupported::NoFiles: specific = &c.strings.unsupportedNonFile; break;
                case selection::Unsupported::VirtualFiles: specific = &c.strings.unsupportedVirtual; break;
                case selection::Unsupported::CloudPlaceholder: specific = &c.strings.unsupportedCloud; break;
                default: break;
            }
            const bool hasSpecific = specific != nullptr && specific->has_value() && !(*specific)->empty();
            if (hasSpecific) {
                m.capsuleText = **specific;
            } else if (session_.cls.reason == selection::Unsupported::CloudPlaceholder) {
                m.capsuleText = cloudPlaceholderText(c.locale);
            } else {
                m.capsuleText = c.strings.unsupported;
            }
            m.capsuleStyle = CapsuleStyle::Reject;
        } else if (session_.hasHit && session_.hit.zone == geo::WheelHit::Zone::Sector) {
            const int i = session_.hit.index;
            const proto::WheelSector& s = session_.sectors[static_cast<size_t>(i)];
            if (s.enabled && session_.armed && session_.copyAllowed) {
                m.highlight = i;
                m.capsuleText = s.label;
                m.capsuleStyle = CapsuleStyle::Active;
            } else if (!s.enabled) {
                m.hover = i;
                m.capsuleText = s.reason && !s.reason->empty() ? *s.reason : c.strings.unsupported;
                m.capsuleStyle = CapsuleStyle::Reject;
            } else if (!session_.copyAllowed) {
                m.hover = i;
                m.capsuleText = c.strings.unsupported;
                m.capsuleStyle = CapsuleStyle::Reject;
            } else {
                m.hover = i;  // not armed yet
                m.capsuleText = defaultCapsuleText();
                m.capsuleStyle = CapsuleStyle::Normal;
            }
        } else {
            m.capsuleText = defaultCapsuleText();
            m.capsuleStyle = CapsuleStyle::Normal;
        }
    }
    // Secondary caption: the capsule's text whenever it names the current
    // choice or a refusal (Active or Reject), as on macOS, where the caption
    // shows exactly while the capsule is in the action or reject style. Windows
    // already shows a disabled or Copy-refused sector's reason before arming, so
    // the caption follows the capsule there too. Nothing without a caption strip.
    if (!m.neutral && m.capsuleStyle != CapsuleStyle::Normal && !m.capsuleText.empty() &&
        session_.frame.panel.captionPlacement != coords::CaptionPlacement::None) {
        m.captionText = m.capsuleText;
        m.captionStyle = m.capsuleStyle;
    }
    const bool changed = !m.sameContent(model_);
    model_ = std::move(m);
    if (push && changed) host_.updateWheel(model_);
}

}  // namespace od::session
