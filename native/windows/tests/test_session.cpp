// Scenario tests of the drag-session state machine with a scripted host.
#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "core/defaults.h"
#include "core/json.h"
#include "core/session.h"
#include "test_framework.h"

using namespace od;
using session::CapsuleStyle;
using session::Effect;
using session::Phase;

namespace {

struct FakeHost : session::Host {
    std::vector<std::string> sent;
    std::vector<coords::Win32Monitor> monitors;
    int shows = 0;
    int updates = 0;
    int hides = 0;
    bool visible = false;
    coords::WheelFrame frame;
    session::RenderModel model;
    session::PollMode poll = session::PollMode::Off;
    int ids = 0;
    std::vector<std::string> logs;
    std::vector<std::pair<std::string, std::vector<std::string>>> folderChecks;

    void send(std::string line) override { sent.push_back(std::move(line)); }
    bool queryMonitors(std::vector<coords::Win32Monitor>& out) override {
        out = monitors;
        return !out.empty();
    }
    void showWheel(const coords::WheelFrame& f, const session::RenderModel& m) override {
        ++shows;
        visible = true;
        frame = f;
        model = m;
    }
    void updateWheel(const session::RenderModel& m) override {
        ++updates;
        model = m;
    }
    void hideWheel(bool) override {
        ++hides;
        visible = false;
    }
    void setPollMode(session::PollMode m) override { poll = m; }
    std::string newSessionId() override { return "s" + std::to_string(++ids); }
    void log(proto::LogLevel, const std::string& m) override { logs.push_back(m); }
    void checkPaths(const std::string& id, const std::vector<std::string>& paths) override { folderChecks.emplace_back(id, paths); }

    json::Value message(size_t i) const {
        json::Value v;
        json::ParseError e;
        json::parse(sent.at(i), v, e);
        return v;
    }
    std::vector<json::Value> ofType(const std::string& type) const {
        std::vector<json::Value> out;
        for (size_t i = 0; i < sent.size(); ++i) {
            json::Value v = message(i);
            if (v.get("type") && v.get("type")->asString() == type) out.push_back(v);
        }
        return out;
    }
    std::string lastType() const {
        if (sent.empty()) return "";
        return message(sent.size() - 1).get("type")->asString();
    }
};

coords::Win32Monitor monitor(double x, double y, double w, double h, double dpi) {
    coords::Win32Monitor m;
    m.bounds = {x, y, w, h};
    m.workArea = {x, y, w, h - 40};
    m.dpi = dpi;
    m.primary = x == 0 && y == 0;
    return m;
}

selection::DragPayload files(std::vector<std::string> paths) {
    selection::DragPayload p;
    p.hasFileList = true;
    p.totalCount = paths.size();
    p.paths = std::move(paths);
    return p;
}

const selection::DragPayload kPdf = files({"C:\\Users\\me\\Docs\\Page 001.pdf"});
const selection::DragPayload kJpg = files({"C:\\Users\\me\\Pictures\\photo.jpg"});

/** What the path-check worker reports. */
selection::PathFacts facts(bool directory, bool cloudPlaceholder = false) {
    selection::PathFacts f;
    f.containsDirectory = directory;
    f.containsCloudPlaceholder = cloudPlaceholder;
    return f;
}

struct Driver {
    FakeHost host;
    std::shared_ptr<proto::Configure> cfg = defaults::referenceConfigure(proto::Locale::En);
    session::Controller ctl{host};
    session::Observation obs;
    int64_t t = 10000;

    Driver() {
        host.monitors = {monitor(0, 0, 1920, 1080, 96)};
        ctl.configure(cfg);
    }
    void tick(int64_t dt = 16) {
        t += dt;
        obs.timeMs = t;
        ctl.tick(obs);
    }
    void wait(int64_t ms) {
        for (int64_t e = 0; e < ms; e += 16) tick(16);
    }
    void down(int x, int y) {
        obs.primaryDown = true;
        obs.pointerValid = true;
        obs.pointer = {x, y};
        tick();
    }
    void moveTo(int x, int y) {
        obs.pointer = {x, y};
        tick();
    }
    void up() {
        obs.primaryDown = false;
        tick();
    }
    void mods(uint8_t m) { obs.modifiers = m; }
    /** Press at (x−10, y), drag to (x, y), hold the modifiers: the wheel appears centred at (x, y). */
    void startWheel(int x, int y, uint8_t m = proto::kModShift) {
        mods(0);  // the combo is pressed after the button (a combo held at the press does not count)
        down(x - 10, y);
        moveTo(x, y);
        mods(m);
        wait(64);
    }
    Effect enter(const selection::DragPayload& p, int x, int y, bool copy = true) {
        return ctl.dragEnter(p, {x, y}, copy, t);
    }
    Effect over(int x, int y, bool copy = true) {
        obs.pointer = {x, y};
        return ctl.dragOver({x, y}, copy, t);
    }
    Effect drop(const selection::DragPayload& p, int x, int y, bool copy = true) {
        obs.pointer = {x, y};
        return ctl.drop(p, {x, y}, copy, t);
    }
};

std::string str(const json::Value& v, const char* key) {
    const json::Value* f = v.get(key);
    return f && f->isString() ? f->asString() : std::string("<missing>");
}

}  // namespace

TEST_CASE("session: Shift drag → neutral wheel → PDF menu → drop on JPG sends one Copy drop") {
    Driver d;
    CHECK(d.host.poll == session::PollMode::Idle);
    d.startWheel(800, 500);
    REQUIRE(d.ctl.phase() == Phase::AwaitingPayload);
    CHECK(d.host.poll == session::PollMode::Active);
    CHECK_EQ(d.host.shows, 1);
    CHECK(d.host.model.neutral);
    CHECK_EQ(d.host.model.capsuleText, std::string("Drop here"));
    CHECK_EQ(d.host.frame.centerPhysical.x, 800.0);  // centre fixed at the activation point
    CHECK_EQ(d.host.frame.centerPhysical.y, 500.0);
    // The candidate drag is not announced; the session starts with the wheel.
    auto states = d.host.ofType("state");
    REQUIRE(states.size() == 1);
    CHECK_EQ(str(states[0], "state"), std::string("AwaitingPayload"));
    CHECK_EQ(str(states[0], "mode"), std::string("convert"));
    const std::string id = str(states[0], "sessionId");
    CHECK(proto::isValidId(id));

    // Real drag-enter with CF_HDROP: menu chosen from the extension map.
    CHECK(d.enter(kPdf, 800, 500) == Effect::None);  // dead zone
    REQUIRE(d.ctl.phase() == Phase::WheelActive);
    states = d.host.ofType("state");
    REQUIRE(states.size() == 2);
    CHECK_EQ(str(states[1], "state"), std::string("WheelActive"));
    CHECK_EQ(str(states[1], "sessionId"), id);
    CHECK_EQ(str(states[1], "menuKey"), std::string("pdf"));
    CHECK_EQ(states[1].get("fileCount")->asNumber(), 1.0);
    CHECK_EQ(d.host.model.sectors.size(), size_t{4});
    CHECK_EQ(d.host.model.capsuleText, std::string("PDF"));

    // JPG is sector 1 (right). Hover highlights and shows the label, never commits.
    CHECK(d.over(920, 500) == Effect::Copy);
    CHECK_EQ(d.host.model.highlight, 1);
    CHECK_EQ(d.host.model.capsuleText, std::string("JPG"));
    CHECK(d.host.model.capsuleStyle == CapsuleStyle::Active);
    CHECK(d.host.ofType("drop").empty());

    CHECK(d.drop(kPdf, 921, 502) == Effect::Copy);
    const auto drops = d.host.ofType("drop");
    REQUIRE(drops.size() == 1);
    CHECK_EQ(str(drops[0], "sessionId"), id);
    CHECK_EQ(str(drops[0], "actionId"), std::string("convert.jpeg"));
    CHECK_EQ(str(drops[0], "mode"), std::string("convert"));
    CHECK_EQ(str(drops[0], "dropEffect"), std::string("copy"));
    CHECK_EQ(drops[0].get("files")->asArray()[0].asString(), kPdf.paths[0]);
    CHECK(!d.host.visible);
    CHECK_EQ(d.host.hides, 1);
    CHECK(d.host.ofType("cancelled").empty());

    // A duplicate Drop (or a late button-up) never produces a second message.
    CHECK(d.drop(kPdf, 921, 502) == Effect::None);
    d.up();
    d.wait(1000);
    CHECK_EQ(d.host.ofType("drop").size(), size_t{1});
    CHECK(d.host.ofType("cancelled").empty());
    CHECK(d.ctl.phase() == Phase::Idle);
    CHECK(d.host.poll == session::PollMode::Idle);
}

TEST_CASE("session: dead zone and outside never select") {
    Driver d;
    d.startWheel(800, 500);
    d.enter(kPdf, 800, 500);
    CHECK(d.over(800, 500) == Effect::None);
    CHECK(d.over(840, 500) == Effect::None);  // 40 DIP < innerRadius 64.8
    CHECK_EQ(d.host.model.highlight, -1);
    CHECK(d.over(800 + 181, 500) == Effect::None);  // outside the disc
    CHECK(d.drop(kPdf, 830, 500) == Effect::None);
    const auto c = d.host.ofType("cancelled");
    REQUIRE(c.size() == 1);
    CHECK_EQ(str(c[0], "reason"), std::string("outsideRing"));
    CHECK(d.host.ofType("drop").empty());
    CHECK(!d.host.visible);
}

TEST_CASE("session: disabled sectors are rejected with their reason") {
    Driver d;
    auto cfg = std::make_shared<proto::Configure>(*d.cfg);
    for (auto& m : cfg->menus) {
        if (m.key == proto::MenuKey::Pdf) {
            m.convert[0].enabled = false;  // DOCX (top)
            m.convert[0].reason = "No DOCX encoder in this build";
        }
    }
    d.ctl.configure(cfg);
    d.startWheel(800, 500);
    d.enter(kPdf, 800, 500);
    CHECK(d.over(800, 380) == Effect::None);
    CHECK_EQ(d.host.model.highlight, -1);
    CHECK_EQ(d.host.model.hover, 0);
    CHECK_EQ(d.host.model.capsuleText, std::string("No DOCX encoder in this build"));
    CHECK(d.host.model.capsuleStyle == CapsuleStyle::Reject);
    CHECK(!d.host.model.sectors[0].enabled);
    CHECK(d.drop(kPdf, 800, 380) == Effect::None);
    REQUIRE(d.host.ofType("cancelled").size() == 1);
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("disabledSector"));
}

TEST_CASE("session: Copy only when the source allows it, never Move") {
    Driver d;
    d.startWheel(800, 500);
    CHECK(d.enter(kPdf, 920, 500, /*copy=*/false) == Effect::None);
    CHECK(d.over(920, 500, false) == Effect::None);
    CHECK_EQ(d.host.model.highlight, -1);
    CHECK(d.host.model.capsuleStyle == CapsuleStyle::Reject);
    CHECK(d.over(920, 500, true) == Effect::Copy);
    CHECK(d.drop(kPdf, 920, 500, false) == Effect::None);
    REQUIRE(d.host.ofType("cancelled").size() == 1);
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("invalidPayload"));
    CHECK(d.host.ofType("drop").empty());
}

TEST_CASE("session: DragLeave keeps the wheel for re-entry; drop after re-entering") {
    Driver d;
    d.startWheel(800, 500);
    d.enter(kPdf, 900, 500);
    d.over(920, 500);
    d.ctl.dragLeave(true, {1100, 500}, d.t);  // pointer left the disc
    CHECK(d.host.visible);
    CHECK_EQ(d.host.model.highlight, -1);
    CHECK(d.ctl.phase() == Phase::WheelActive);
    d.moveTo(1150, 520);
    d.wait(300);
    CHECK(d.host.visible);
    CHECK(d.enter(kPdf, 800, 620) == Effect::Copy);  // re-entry from below: PNG (sector 2)
    CHECK_EQ(d.host.model.highlight, 2);
    CHECK(d.drop(kPdf, 800, 620) == Effect::Copy);
    REQUIRE(d.host.ofType("drop").size() == 1);
    CHECK_EQ(str(d.host.ofType("drop")[0], "actionId"), std::string("convert.png"));
}

TEST_CASE("session: drag ends outside the wheel → cancelled dragEnded") {
    Driver d;
    d.startWheel(800, 500);
    d.enter(kPdf, 900, 500);
    d.ctl.dragLeave(true, {1200, 500}, d.t);
    d.moveTo(1300, 500);
    d.up();  // dropped somewhere else (the source performs its normal action)
    REQUIRE(d.host.ofType("cancelled").size() == 1);
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("dragEnded"));
    CHECK(!d.host.visible);
    CHECK(d.ctl.phase() == Phase::Idle);
}

TEST_CASE("session: polled button-up over the wheel waits for the OLE drop") {
    Driver d;
    d.startWheel(800, 500);
    d.enter(kPdf, 920, 500);
    d.over(920, 500);
    d.up();  // the poll sees the release before the cross-process Drop arrives
    CHECK(d.host.ofType("cancelled").empty());
    CHECK(d.host.visible);
    d.wait(200);
    CHECK(d.drop(kPdf, 920, 500) == Effect::Copy);
    CHECK_EQ(d.host.ofType("drop").size(), size_t{1});
    CHECK(d.host.ofType("cancelled").empty());

    Driver e;  // no Drop at all: give up after the grace period
    e.startWheel(800, 500);
    e.enter(kPdf, 920, 500);
    e.up();
    e.wait(400);
    CHECK(e.host.ofType("cancelled").empty());
    e.wait(400);
    REQUIRE(e.host.ofType("cancelled").size() == 1);
    CHECK_EQ(str(e.host.ofType("cancelled")[0], "reason"), std::string("dragEnded"));
    CHECK(!e.host.visible);
}

TEST_CASE("session: refused release on the disc reports the zone (both event orders)") {
    // OLE calls DragLeave instead of Drop when the last effect was None.
    Driver d;
    d.startWheel(800, 500);
    d.enter(kPdf, 830, 500);  // dead zone
    d.ctl.dragLeave(true, {830, 500}, d.t);
    d.up();
    REQUIRE(d.host.ofType("cancelled").size() == 1);
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("outsideRing"));

    Driver e;
    e.startWheel(800, 500);
    e.enter(kPdf, 830, 500);
    e.up();  // poll first …
    CHECK(e.host.ofType("cancelled").empty());
    e.ctl.dragLeave(true, {830, 500}, e.t);  // … then the DragLeave
    REQUIRE(e.host.ofType("cancelled").size() == 1);
    CHECK_EQ(str(e.host.ofType("cancelled")[0], "reason"), std::string("outsideRing"));
}

TEST_CASE("session: Esc cancels and suppresses the wheel until the button is released") {
    Driver d;
    d.startWheel(800, 500);
    d.enter(kPdf, 900, 500);
    d.obs.escapeDown = true;
    d.tick();
    REQUIRE(d.host.ofType("cancelled").size() == 1);
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("escape"));
    CHECK(!d.host.visible);
    CHECK(d.ctl.phase() == Phase::Cooldown);
    d.obs.escapeDown = false;
    d.moveTo(700, 400);  // still dragging with Shift held: no new wheel
    d.wait(200);
    CHECK_EQ(d.host.shows, 1);
    d.up();
    CHECK(d.ctl.phase() == Phase::Idle);
    d.startWheel(600, 400);  // next drag works again
    CHECK_EQ(d.host.shows, 2);
}

TEST_CASE("session: releasing the modifier keeps an active wheel") {
    Driver d;
    d.startWheel(800, 500);
    d.enter(kPdf, 800, 500);
    d.mods(0);
    d.wait(300);
    CHECK(d.host.visible);
    CHECK(d.ctl.phase() == Phase::WheelActive);
    CHECK(d.over(680, 500) == Effect::Copy);  // TXT (left)
    CHECK(d.drop(kPdf, 680, 500) == Effect::Copy);
    CHECK_EQ(str(d.host.ofType("drop")[0], "actionId"), std::string("convert.txt"));
}

TEST_CASE("session: Alt+Shift opens tools; adding Alt upgrades; releasing keys never flips") {
    Driver d;  // chord pressed Shift-first within the debounce: tools directly, no convert flash
    d.down(790, 500);
    d.moveTo(800, 500);
    d.mods(proto::kModShift);
    d.tick(16);
    d.mods(proto::kModShift | proto::kModAlt);
    d.wait(64);
    REQUIRE(d.ctl.phase() == Phase::AwaitingPayload);
    CHECK(d.ctl.mode() == proto::WheelMode::Tools);
    CHECK_EQ(d.host.shows, 1);
    d.enter(kJpg, 800, 500);
    CHECK_EQ(d.host.model.sectors.size(), size_t{7});
    CHECK_EQ(d.host.model.sectors[0].label, std::string("COMPRESS"));
    d.mods(proto::kModShift);  // Alt released first, Shift still held: a release never switches
    d.wait(200);
    CHECK(d.ctl.mode() == proto::WheelMode::Tools);
    d.mods(0);
    d.wait(100);
    CHECK(d.ctl.mode() == proto::WheelMode::Tools);
    d.mods(proto::kModShift);  // pressing Shift again completes the convert combo
    d.wait(64);
    CHECK(d.ctl.mode() == proto::WheelMode::Convert);
    CHECK_EQ(d.host.model.sectors[0].label, std::string("PNG"));

    Driver e;  // slow chord: convert wheel first, then upgraded to tools
    e.startWheel(800, 500, proto::kModShift);
    e.enter(kJpg, 800, 500);
    CHECK(e.ctl.mode() == proto::WheelMode::Convert);
    CHECK_EQ(e.host.model.sectors[0].label, std::string("PNG"));
    e.mods(proto::kModShift | proto::kModAlt);
    e.wait(64);
    CHECK(e.ctl.mode() == proto::WheelMode::Tools);
    CHECK_EQ(e.host.model.sectors.size(), size_t{7});
    const auto st = e.host.ofType("state");
    CHECK_EQ(str(st.back(), "state"), std::string("WheelActive"));
    CHECK_EQ(str(st.back(), "mode"), std::string("tools"));
    // CROP (sector 5) at ~ -141°.
    const double a = (-90 + 5 * 360.0 / 7) * 3.14159265358979 / 180;
    const int cx = 800 + static_cast<int>(std::lround(120 * std::cos(a)));
    const int cy = 500 + static_cast<int>(std::lround(120 * std::sin(a)));
    CHECK(e.over(cx, cy) == Effect::Copy);
    CHECK(e.drop(kJpg, cx, cy) == Effect::Copy);
    CHECK_EQ(str(e.host.ofType("drop")[0], "actionId"), std::string("tool.crop"));
    CHECK_EQ(str(e.host.ofType("drop")[0], "mode"), std::string("tools"));
}

TEST_CASE("session: other modifier sets do not open the wheel") {
    Driver d;
    d.down(790, 500);
    d.moveTo(800, 500);
    d.mods(proto::kModShift | proto::kModControl);  // Ctrl+Shift (Explorer: create link)
    d.wait(200);
    CHECK(d.ctl.phase() == Phase::PotentialDrag);
    CHECK_EQ(d.host.shows, 0);
    d.up();
    CHECK(d.host.sent.empty());  // a drag that never showed the wheel is not reported at all
    CHECK(d.ctl.phase() == Phase::Idle);
}

TEST_CASE("session: arming after a shifted activation near the screen edge") {
    Driver d;
    d.startWheel(1905, 500);  // right edge: the wheel is shifted left by ~173 DIP
    REQUIRE(d.ctl.phase() == Phase::AwaitingPayload);
    const auto& f = d.host.frame;
    CHECK(f.placement.shifted);
    CHECK_EQ(f.centerPhysical.x, 1920.0 - 188);
    CHECK_EQ(f.centerPhysical.y, 500.0);
    // The pointer is still at the activation point, which now lies on sector 1 (JPG).
    d.enter(kPdf, 1905, 500);
    CHECK(d.over(1905, 500) == Effect::None);  // not armed: an immediate drop must not select
    CHECK_EQ(d.host.model.highlight, -1);
    CHECK_EQ(d.host.model.hover, 1);
    CHECK(d.drop(kPdf, 1905, 500) == Effect::None);
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("outsideRing"));

    Driver e;
    e.startWheel(1905, 500);
    e.enter(kPdf, 1905, 500);
    CHECK(e.over(1905, 500) == Effect::None);
    CHECK(e.over(1902, 500) == Effect::None);  // 3 DIP < armDistance 6
    CHECK(e.over(1898, 500) == Effect::Copy);  // 7 DIP: armed
    CHECK(e.over(1905, 500) == Effect::None);  // back on the activation point: isArmed is evaluated per pointer
    CHECK(e.over(1897, 500) == Effect::Copy);
    CHECK(e.drop(kPdf, 1897, 500) == Effect::Copy);

    Driver c;  // corner: the activation point is off the disc, entering it arms naturally
    c.startWheel(1910, 1030);
    CHECK_EQ(c.host.frame.centerPhysical.y, 1040.0 - 188);
    c.enter(kPdf, 1850, 960);
    CHECK(c.over(1850, 960) == Effect::Copy);
}

TEST_CASE("session: unsupported payloads show the reason and refuse the drop") {
    Driver d;
    d.startWheel(800, 500);
    CHECK(d.enter(files({"C:\\notes.txt"}), 920, 500) == Effect::None);
    const auto st = d.host.ofType("state");
    CHECK(st.back().get("menuKey")->isNull());
    CHECK(d.host.model.unsupported);
    CHECK_EQ(d.host.model.capsuleText, std::string("Not supported"));
    CHECK(d.host.model.capsuleStyle == CapsuleStyle::Reject);
    CHECK(d.over(920, 500) == Effect::None);
    CHECK(d.drop(files({"C:\\notes.txt"}), 920, 500) == Effect::None);
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("invalidPayload"));

    for (int kind = 0; kind < 4; ++kind) {
        Driver e;
        e.startWheel(800, 500);
        selection::DragPayload p;
        if (kind == 0) p.virtualFilesOnly = true;                           // Outlook attachment / zip entry
        if (kind == 1) p = files(std::vector<std::string>(201, "C:\\a.png"));  // too many
        if (kind == 2) {
            p = files({"C:\\folder.png"});
            p.containsDirectory = true;
        }
        // kind 3: text drag (no CF_HDROP)
        CHECK(e.enter(p, 920, 500) == Effect::None);
        CHECK(e.host.model.unsupported);
        CHECK(e.over(920, 500) == Effect::None);
    }
}

TEST_CASE("session: tools wheel for a PDF has no sectors (unsupported)") {
    Driver d;
    d.startWheel(800, 500, proto::kModShift | proto::kModAlt);
    d.enter(kPdf, 920, 500);
    const auto st = d.host.ofType("state");
    CHECK_EQ(str(st.back(), "menuKey"), std::string("pdf"));
    CHECK(d.host.model.unsupported);
    CHECK(d.over(920, 500) == Effect::None);
}

TEST_CASE("session: multi-file drags disable non-batch sectors and show the count") {
    Driver d;
    d.startWheel(800, 500, proto::kModShift | proto::kModAlt);
    const auto two = files({"C:\\a.jpg", "C:\\b.jpg"});
    d.enter(two, 800, 500);
    CHECK_EQ(str(d.host.ofType("state").back(), "menuKey"), std::string("image/jpeg"));
    CHECK_EQ(d.host.ofType("state").back().get("fileCount")->asNumber(), 2.0);
    CHECK_EQ(d.host.model.capsuleText, std::string("2 files"));
    CHECK(d.host.model.sectors[0].enabled);   // COMPRESS (batch)
    CHECK(!d.host.model.sectors[5].enabled);  // CROP
    const double a = (-90 + 5 * 360.0 / 7) * 3.14159265358979 / 180;
    const int cx = 800 + static_cast<int>(std::lround(120 * std::cos(a)));
    const int cy = 500 + static_cast<int>(std::lround(120 * std::sin(a)));
    CHECK(d.over(cx, cy) == Effect::None);
    CHECK_EQ(d.host.model.capsuleText, std::string("One file at a time"));
    CHECK(d.over(800, 380) == Effect::Copy);  // COMPRESS at the top
    CHECK(d.drop(two, 800, 380) == Effect::Copy);
    CHECK_EQ(d.host.ofType("drop")[0].get("files")->asArray().size(), size_t{2});

    Driver m;  // PDF + PNG → mixed menu
    m.startWheel(800, 500);
    m.enter(files({"C:\\a.pdf", "C:\\b.png"}), 800, 500);
    CHECK_EQ(str(m.host.ofType("state").back(), "menuKey"), std::string("mixed"));
    CHECK_EQ(m.host.model.sectors.size(), size_t{3});
}

TEST_CASE("session: the drop payload is re-validated") {
    Driver d;
    d.startWheel(800, 500);
    d.enter(kPdf, 920, 500);
    d.over(920, 500);
    CHECK(d.drop(files({"C:\\x.png"}), 920, 500) == Effect::None);  // different files than at DragEnter
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("invalidPayload"));
}

TEST_CASE("session: no DragEnter while moving over the neutral wheel → not a file drag") {
    Driver d;
    d.startWheel(800, 500);
    REQUIRE(d.ctl.phase() == Phase::AwaitingPayload);
    for (int i = 0; i < 30; ++i) d.moveTo(800 + (i % 2 ? 15 : -15), 500 + i);  // text selection with Shift
    REQUIRE(d.host.ofType("cancelled").size() == 1);
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("invalidPayload"));
    CHECK(!d.host.visible);
    CHECK(d.ctl.phase() == Phase::Cooldown);

    Driver e;  // a still pointer keeps waiting
    e.startWheel(800, 500);
    e.wait(2000);
    CHECK(e.ctl.phase() == Phase::AwaitingPayload);
    e.up();
    CHECK_EQ(str(e.host.ofType("cancelled")[0], "reason"), std::string("dragEnded"));
}

TEST_CASE("session: window moves and menus never become drag candidates") {
    Driver d;
    d.obs.suppressed = true;
    d.down(500, 10);
    d.moveTo(600, 30);
    d.mods(proto::kModShift);
    d.wait(200);
    CHECK(d.ctl.phase() == Phase::Cooldown);
    CHECK(d.host.sent.empty());
    d.up();
    CHECK(d.ctl.phase() == Phase::Idle);

    Driver e;  // movement inside the drag rectangle is not a drag
    e.obs.dragThresholdX = 8;
    e.obs.dragThresholdY = 8;
    e.down(500, 500);
    e.moveTo(503, 497);
    e.mods(proto::kModShift);
    e.wait(100);
    CHECK(e.ctl.phase() == Phase::Pressed);
    e.moveTo(505, 500);
    CHECK(e.ctl.phase() == Phase::PotentialDrag);
}

TEST_CASE("session: cancelSession, disable, sleep and shutdown") {
    Driver d;
    d.startWheel(800, 500);
    d.ctl.cancelSession("not-mine");
    CHECK(d.host.visible);
    d.ctl.cancelSession(d.ctl.sessionId());
    CHECK(!d.host.visible);
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("parentRequest"));

    Driver e;
    e.startWheel(800, 500);
    auto off = std::make_shared<proto::Configure>(*e.cfg);
    off->enabled = false;
    e.ctl.configure(off);
    CHECK(!e.host.visible);
    CHECK_EQ(str(e.host.ofType("cancelled")[0], "reason"), std::string("parentRequest"));
    CHECK(e.host.poll == session::PollMode::Off);
    e.down(100, 100);
    e.moveTo(200, 200);
    e.mods(proto::kModShift);
    e.wait(200);
    CHECK_EQ(e.host.shows, 1);  // disabled: nothing observed

    Driver s;
    s.startWheel(800, 500);
    s.enter(kPdf, 800, 500);
    s.ctl.setSuspended(true);
    CHECK(!s.host.visible);
    CHECK_EQ(str(s.host.ofType("cancelled")[0], "reason"), std::string("sleep"));
    CHECK(s.host.poll == session::PollMode::Off);
    s.ctl.setSuspended(false);
    CHECK(s.host.poll != session::PollMode::Off);

    Driver x;
    x.startWheel(800, 500);
    x.ctl.shutdown();
    CHECK(!x.host.visible);
    CHECK_EQ(str(x.host.ofType("cancelled")[0], "reason"), std::string("parentRequest"));
    CHECK(x.host.poll == session::PollMode::Off);
}

TEST_CASE("session: configuration changes do not reorder an active wheel") {
    Driver d;
    d.startWheel(800, 500);
    d.enter(kPdf, 800, 500);
    auto other = std::make_shared<proto::Configure>(*d.cfg);
    for (auto& m : other->menus) {
        if (m.key == proto::MenuKey::Pdf) std::swap(m.convert[1], m.convert[3]);  // JPG ↔ TXT
    }
    d.ctl.configure(other);
    CHECK(d.over(920, 500) == Effect::Copy);
    CHECK(d.drop(kPdf, 920, 500) == Effect::Copy);
    CHECK_EQ(str(d.host.ofType("drop")[0], "actionId"), std::string("convert.jpeg"));  // frozen order
    d.up();
    d.startWheel(800, 500);  // the next session uses the new order
    d.enter(kPdf, 800, 500);
    d.over(920, 500);
    d.drop(kPdf, 920, 500);
    CHECK_EQ(str(d.host.ofType("drop")[1], "actionId"), std::string("convert.txt"));
}

TEST_CASE("session: 150 % monitor with negative coordinates") {
    Driver d;
    d.host.monitors = {monitor(0, 0, 1920, 1080, 96), monitor(-2880, -300, 2880, 1620, 144)};
    d.startWheel(-1500, 400);
    REQUIRE(d.ctl.phase() == Phase::AwaitingPayload);
    CHECK_EQ(d.host.frame.scale, 1.5);
    CHECK_NEAR(d.host.frame.centerPhysical.x, -1500.0, 1e-9);
    CHECK_NEAR(d.host.frame.centerPhysical.y, 400.0, 1e-9);
    d.enter(kPdf, -1500, 400);
    // 120 DIP = 180 px to the right → JPG; 100 px (66.7 DIP) is just outside the dead zone.
    CHECK(d.over(-1500 + 180, 400) == Effect::Copy);
    CHECK(d.over(-1500 + 96, 400) == Effect::None);   // 64 DIP: dead zone
    CHECK(d.over(-1500 + 100, 400) == Effect::Copy);  // 66.7 DIP
    CHECK(d.over(-1500 + 271, 400) == Effect::None);  // 180.7 DIP: outside
    CHECK(d.drop(kPdf, -1500 + 180, 400) == Effect::Copy);
}

TEST_CASE("session: exactly one hide per wheel and no wheel without monitors") {
    Driver d;
    d.startWheel(800, 500);
    d.enter(kPdf, 920, 500);
    d.drop(kPdf, 920, 500);
    d.up();
    d.wait(1000);
    CHECK_EQ(d.host.shows, 1);
    CHECK_EQ(d.host.hides, 1);

    Driver e;
    e.host.monitors.clear();
    e.startWheel(800, 500);
    CHECK_EQ(e.host.shows, 0);
    CHECK(e.ctl.phase() == Phase::Cooldown);
    CHECK(e.host.sent.empty());
}

TEST_CASE("session: a combo already held at the press never opens the wheel (Shift + selection)") {
    Driver d;
    d.mods(proto::kModShift);  // Shift + text selection / marquee
    d.down(500, 500);
    d.moveTo(560, 520);
    d.wait(800);
    CHECK(d.ctl.phase() == Phase::PotentialDrag);
    CHECK_EQ(d.host.shows, 0);
    CHECK(d.host.sent.empty());
    d.mods(proto::kModShift | proto::kModAlt);  // a key press completing the tools combo does count
    d.wait(64);
    REQUIRE(d.ctl.phase() == Phase::AwaitingPayload);
    CHECK(d.ctl.mode() == proto::WheelMode::Tools);
    d.up();

    Driver e;  // releasing and pressing Shift again during the drag opens convert
    e.mods(proto::kModShift);
    e.down(500, 500);
    e.moveTo(560, 520);
    e.wait(100);
    e.mods(0);
    e.wait(32);
    e.mods(proto::kModShift);
    e.wait(64);
    CHECK(e.ctl.phase() == Phase::AwaitingPayload);
    CHECK(e.ctl.mode() == proto::WheelMode::Convert);
    CHECK_EQ(e.host.shows, 1);

    Driver f;  // pressed before the drag threshold, after the button: counts once the drag starts
    f.down(500, 500);
    f.mods(proto::kModShift);
    f.wait(64);
    CHECK(f.ctl.phase() == Phase::Pressed);
    f.moveTo(540, 500);
    f.wait(32);
    CHECK(f.ctl.phase() == Phase::AwaitingPayload);
}

TEST_CASE("session: folders are detected off the UI thread and change the outcome") {
    Driver d;
    d.startWheel(800, 500);
    d.enter(kPdf, 920, 500);
    REQUIRE(d.host.folderChecks.size() == 1);
    CHECK_EQ(d.host.folderChecks[0].first, d.ctl.sessionId());
    CHECK(d.host.folderChecks[0].second == kPdf.paths);
    CHECK(d.over(920, 500) == Effect::Copy);
    d.ctl.fileInfo("someone-else", facts(true));  // a late answer for another session is ignored
    CHECK(d.over(920, 500) == Effect::Copy);
    d.ctl.fileInfo(d.ctl.sessionId(), facts(false));
    CHECK(d.over(920, 500) == Effect::Copy);
    const size_t statesBefore = d.host.ofType("state").size();
    d.ctl.fileInfo(d.ctl.sessionId(), facts(true));  // "Page 001.pdf" is a folder after all
    const auto states = d.host.ofType("state");
    REQUIRE(states.size() == statesBefore + 1);
    CHECK(states.back().get("menuKey")->isNull());
    CHECK(d.host.model.unsupported);
    CHECK_EQ(d.host.model.capsuleText, std::string("Folders aren't supported"));
    CHECK(d.over(920, 500) == Effect::None);
    CHECK(d.drop(kPdf, 920, 500) == Effect::None);
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("invalidPayload"));

    Driver e;  // an extensionless folder: already unsupported, only the wording changes
    e.startWheel(800, 500);
    e.enter(files({"C:\\Users\\me\\Pictures"}), 800, 500);
    CHECK_EQ(e.host.model.capsuleText, std::string("Not supported"));
    REQUIRE(e.host.folderChecks.size() == 1);
    const size_t n = e.host.ofType("state").size();
    e.ctl.fileInfo(e.ctl.sessionId(), facts(true));
    CHECK_EQ(e.host.model.capsuleText, std::string("Folders aren't supported"));
    CHECK_EQ(e.host.ofType("state").size(), n);  // menuKey was already null: no new state

    Driver v;  // nothing to check for virtual files or non-file data
    v.startWheel(800, 500);
    selection::DragPayload virt;
    virt.virtualFilesOnly = true;
    v.enter(virt, 800, 500);
    CHECK(v.host.folderChecks.empty());
}

TEST_CASE("session: configure's unsupportedCloud replaces the built-in cloud text") {
    for (const auto& [configured, shown] : {std::pair<std::string, std::string>{"Get it from OneDrive first", "Get it from OneDrive first"},
                                            std::pair<std::string, std::string>{"", "Download it first"}}) {
        auto cfg = std::make_shared<proto::Configure>(*defaults::referenceConfigure(proto::Locale::En));
        cfg->strings.unsupportedCloud = configured;
        Driver d;
        d.ctl.configure(cfg);
        d.startWheel(800, 500);
        d.enter(kPdf, 920, 500);
        d.ctl.fileInfo(d.ctl.sessionId(), facts(false, /*cloudPlaceholder=*/true));
        CHECK(d.host.model.unsupported);
        CHECK_EQ(d.host.model.capsuleText, shown);
    }
}

TEST_CASE("session: cloud-only placeholders are refused, never read") {
    Driver d;
    d.startWheel(800, 500);
    d.enter(kPdf, 920, 500);
    REQUIRE(d.host.folderChecks.size() == 1);  // the worker reads attributes only, after DragEnter
    CHECK(d.over(920, 500) == Effect::Copy);   // offered until the answer arrives
    const size_t statesBefore = d.host.ofType("state").size();
    d.ctl.fileInfo(d.ctl.sessionId(), facts(false, /*cloudPlaceholder=*/true));
    const auto states = d.host.ofType("state");
    REQUIRE(states.size() == statesBefore + 1);
    CHECK(states.back().get("menuKey")->isNull());
    CHECK(d.host.model.unsupported);
    CHECK_EQ(d.host.model.capsuleText, std::string("Download it first"));
    CHECK(d.host.model.capsuleStyle == CapsuleStyle::Reject);
    CHECK(d.over(920, 500) == Effect::None);
    CHECK(d.drop(kPdf, 920, 500) == Effect::None);
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("invalidPayload"));
    CHECK(d.host.ofType("drop").empty());

    Driver k;  // Korean wording
    k.ctl.configure(defaults::referenceConfigure(proto::Locale::Ko));
    k.startWheel(800, 500);
    k.enter(kPdf, 920, 500);
    k.ctl.fileInfo(k.ctl.sessionId(), facts(false, true));
    CHECK_EQ(k.host.model.capsuleText, std::string("\xEB\xA8\xBC\xEC\xA0\x80 \xEB\x82\xB4\xEB\xA0\xA4\xEB\xB0\x9B\xEC\x9C\xBC\xEC\x84\xB8\xEC\x9A\x94"));

    Driver f;  // a folder wins over a placeholder, in one answer or in two
    f.startWheel(800, 500);
    f.enter(files({"C:\\a.pdf", "C:\\b.pdf"}), 800, 500);
    f.ctl.fileInfo(f.ctl.sessionId(), facts(true, true));
    CHECK_EQ(f.host.model.capsuleText, std::string("Folders aren't supported"));
    const size_t n = f.host.ofType("state").size();
    f.ctl.fileInfo(f.ctl.sessionId(), facts(false, true));
    CHECK_EQ(f.host.model.capsuleText, std::string("Folders aren't supported"));
    CHECK_EQ(f.host.ofType("state").size(), n);

    Driver u;  // an unsupported type stays plain "unsupported"
    u.startWheel(800, 500);
    u.enter(files({"C:\\notes.txt"}), 800, 500);
    const size_t m = u.host.ofType("state").size();
    u.ctl.fileInfo(u.ctl.sessionId(), facts(false, true));
    CHECK_EQ(u.host.model.capsuleText, std::string("Not supported"));
    CHECK_EQ(u.host.ofType("state").size(), m);

    Driver late;  // an answer for a finished session changes nothing
    late.startWheel(800, 500);
    late.enter(kPdf, 920, 500);
    const std::string old = late.ctl.sessionId();
    late.drop(kPdf, 920, 500);
    late.up();
    late.startWheel(800, 500);
    late.enter(kPdf, 920, 500);
    late.ctl.fileInfo(old, facts(false, true));
    CHECK(!late.host.model.unsupported);
    CHECK(late.over(920, 500) == Effect::Copy);
}

TEST_CASE("session: specific unsupported texts with fallback") {
    Driver d;
    d.startWheel(800, 500);
    selection::DragPayload virt;
    virt.virtualFilesOnly = true;
    d.enter(virt, 800, 500);
    CHECK_EQ(d.host.model.capsuleText, std::string("No file on disk"));

    Driver t;
    t.startWheel(800, 500);
    t.enter(selection::DragPayload(), 800, 500);  // text / URL
    CHECK_EQ(t.host.model.capsuleText, std::string("Not a file"));

    Driver f;  // configure without the optional strings: generic text
    auto cfg = std::make_shared<proto::Configure>(*f.cfg);
    cfg->strings.unsupportedVirtual.reset();
    cfg->strings.unsupportedNonFile = std::string();
    f.ctl.configure(cfg);
    f.startWheel(800, 500);
    f.enter(virt, 800, 500);
    CHECK_EQ(f.host.model.capsuleText, std::string("Not supported"));

    Driver p;  // a PDF in the tools wheel is supported input with no sectors: generic text
    p.startWheel(800, 500, proto::kModShift | proto::kModAlt);
    p.enter(kPdf, 800, 500);
    CHECK_EQ(p.host.model.capsuleText, std::string("Not supported"));
}

TEST_CASE("session: display changes cancel a wheel whose monitor changed") {
    Driver d;
    d.host.monitors = {monitor(0, 0, 1920, 1080, 96), monitor(-2880, 0, 2880, 1620, 144)};
    d.host.monitors[0].id = "\\\\.\\DISPLAY1";
    d.host.monitors[1].id = "\\\\.\\DISPLAY2";
    d.startWheel(-1500, 400);
    REQUIRE(d.ctl.phase() == Phase::AwaitingPayload);
    auto same = d.host.monitors;
    same[0].workArea.height -= 20;  // another monitor / taskbar change: keep the wheel
    d.ctl.displaysChanged(same);
    CHECK(d.ctl.phase() == Phase::AwaitingPayload);
    auto rescaled = d.host.monitors;
    rescaled[1].dpi = 192;  // the wheel's monitor changed scale
    d.ctl.displaysChanged(rescaled);
    CHECK(d.ctl.phase() == Phase::Cooldown);
    CHECK(!d.host.visible);
    CHECK_EQ(str(d.host.ofType("cancelled")[0], "reason"), std::string("error"));

    Driver e;
    e.host.monitors = {monitor(0, 0, 1920, 1080, 96), monitor(-2880, 0, 2880, 1620, 144)};
    e.startWheel(-1500, 400);
    e.enter(kPdf, -1500, 400);
    e.ctl.displaysChanged({monitor(0, 0, 1920, 1080, 96)});  // unplugged
    CHECK(!e.host.visible);
    CHECK_EQ(str(e.host.ofType("cancelled")[0], "reason"), std::string("error"));
    e.ctl.displaysChanged({});  // no session: nothing happens
    CHECK_EQ(e.host.ofType("cancelled").size(), size_t{1});
}
