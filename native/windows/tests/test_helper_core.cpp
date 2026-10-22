#include <string>
#include <vector>

#include "core/defaults.h"
#include "core/helper_core.h"
#include "core/json.h"
#include "test_framework.h"

using namespace od;

namespace {

struct FakePlatform : HelperCore::Platform {
    std::vector<std::string> sent;
    int exitCode = -1;
    int hides = 0;
    session::PollMode poll = session::PollMode::Off;

    void send(std::string line) override { sent.push_back(std::move(line)); }
    bool queryMonitors(std::vector<coords::Win32Monitor>& out) override {
        coords::Win32Monitor m;
        m.bounds = {0, 0, 1920, 1080};
        m.workArea = {0, 0, 1920, 1040};
        m.primary = true;
        out = {m};
        return true;
    }
    void showWheel(const coords::WheelFrame&, const session::RenderModel&) override {}
    void updateWheel(const session::RenderModel&) override {}
    void hideWheel(bool) override { ++hides; }
    void setPollMode(session::PollMode m) override { poll = m; }
    std::string newSessionId() override { return "x1"; }
    void log(proto::LogLevel, const std::string&) override {}
    void requestExit(int code) override { exitCode = code; }

    std::string type(size_t i) const {
        json::Value v;
        json::ParseError e;
        if (!json::parse(sent.at(i), v, e)) return "<invalid>";
        return v.get("type")->asString();
    }
    json::Value msg(size_t i) const {
        json::Value v;
        json::ParseError e;
        json::parse(sent.at(i), v, e);
        return v;
    }
};

}  // namespace

TEST_CASE("helper core: ready, ping/pong, permissions") {
    FakePlatform p;
    HelperCore core(p);
    proto::ReadyInfo info;
    info.helperVersion = ORBITDROP_HELPER_VERSION;
    info.arch = "x64";
    info.osVersion = "10.0.26100";
    info.pid = 77;
    core.start(info);
    REQUIRE(p.sent.size() == 1);
    CHECK_EQ(p.type(0), std::string("ready"));
    CHECK_EQ(p.msg(0).get("helperVersion")->asString(), std::string(ORBITDROP_HELPER_VERSION));

    core.handleLine(R"({"v":1,"type":"ping","nonce":12345})");
    REQUIRE(p.sent.size() == 2);
    CHECK_EQ(p.sent[1], std::string(R"({"v":1,"type":"pong","nonce":12345})"));
    core.handleLine(R"({"v":1,"type":"queryPermissions"})");
    CHECK_EQ(p.sent[2], std::string(R"({"v":1,"type":"permissions","items":[]})"));
    core.handleLine("   ");  // blank lines are ignored silently
    CHECK_EQ(p.sent.size(), size_t{3});
}

TEST_CASE("helper core: invalid messages are reported without echoing contents") {
    FakePlatform p;
    HelperCore core(p);
    core.handleLine(R"({"v":1,"type":"ping","nonce":"C:\\secret\\path.pdf"})");
    REQUIRE(p.sent.size() == 1);
    CHECK_EQ(p.type(0), std::string("error"));
    const json::Value e = p.msg(0);
    CHECK_EQ(e.get("code")->asString(), std::string("invalidMessage"));
    CHECK(!e.get("fatal")->asBool());
    CHECK(e.get("message")->asString().find("secret") == std::string::npos);
    core.handleLine("{oops");
    CHECK_EQ(p.msg(1).get("code")->asString(), std::string("invalidJson"));
    core.handleLine(R"({"v":7,"type":"ping","nonce":1})");
    CHECK_EQ(p.msg(2).get("code")->asString(), std::string("protocolVersion"));
    core.handleLine(R"({"v":1,"type":"hello"})");
    CHECK_EQ(p.msg(3).get("code")->asString(), std::string("unknownType"));
    core.handleLineTooLong();
    CHECK_EQ(p.msg(4).get("code")->asString(), std::string("lineTooLong"));
    // An unknown key is message content too: only field-like names appear in the report.
    core.handleLine(R"({"v":1,"type":"ping","nonce":1,"C:\\Users\\me\\secret.pdf":0})");
    REQUIRE(p.sent.size() == 6);
    CHECK_EQ(p.msg(5).get("code")->asString(), std::string("invalidMessage"));
    CHECK(p.msg(5).get("message")->asString().find("secret") == std::string::npos);
    CHECK(p.msg(5).get("message")->asString().find("<key>: unknown field") != std::string::npos);
    core.handleLine(R"({"v":1,"type":"ping","nonce":1,"extra_field":0})");
    CHECK(p.msg(6).get("message")->asString().find("extra_field: unknown field") != std::string::npos);
    for (int i = 0; i < 100; ++i) core.handleLine("nope");  // reports are capped
    CHECK(p.sent.size() <= 50);
    CHECK_EQ(p.exitCode, -1);  // protocol errors are never fatal
}

TEST_CASE("helper core: configure enables observation; shutdown and EOF exit") {
    FakePlatform p;
    HelperCore core(p);
    CHECK(!core.configured());
    core.handleLine(defaults::configureToJson(*defaults::referenceConfigure()));
    CHECK(core.configured());
    CHECK(core.controller().enabled());
    CHECK(p.poll == session::PollMode::Idle);
    core.handleLine(R"({"v":1,"type":"cancelSession","sessionId":"none"})");
    CHECK(p.sent.empty());
    core.handleLine(R"({"v":1,"type":"shutdown"})");
    CHECK_EQ(p.exitCode, 0);
    CHECK(p.poll == session::PollMode::Off);
    core.handleLine(R"({"v":1,"type":"ping","nonce":1})");  // ignored once exiting
    CHECK(p.sent.empty());

    FakePlatform q;
    HelperCore c2(q);
    c2.handleLine(defaults::configureToJson(*defaults::referenceConfigure()));
    c2.handleInputClosed();
    CHECK_EQ(q.exitCode, 0);
    CHECK(q.hides >= 1);
}

TEST_CASE("line splitter: chunks, CRLF, overlong lines") {
    LineSplitter sp(16);
    std::vector<std::string> lines;
    int overflows = 0;
    const auto onLine = [&](std::string_view l) { lines.emplace_back(l); };
    const auto onOverflow = [&] { ++overflows; };
    const std::string a = "{\"a\":1}\n{\"b\"";
    sp.feed(a.data(), a.size(), onLine, onOverflow);
    REQUIRE(lines.size() == 1);
    CHECK_EQ(lines[0], std::string("{\"a\":1}"));
    CHECK_EQ(sp.pending(), size_t{4});
    const std::string b = ":2}\r\n\n";
    sp.feed(b.data(), b.size(), onLine, onOverflow);
    REQUIRE(lines.size() == 3);
    CHECK_EQ(lines[1], std::string("{\"b\":2}\r"));  // '\r' is JSON whitespace
    CHECK_EQ(lines[2], std::string(""));
    const std::string exact(16, 'x');
    sp.feed((exact + "\n").data(), 17, onLine, onOverflow);
    CHECK_EQ(lines.back(), exact);
    CHECK_EQ(overflows, 0);
    const std::string longLine(40, 'y');
    sp.feed(longLine.data(), 10, onLine, onOverflow);
    sp.feed(longLine.data(), 10, onLine, onOverflow);  // crosses the limit across chunks
    CHECK_EQ(overflows, 1);
    sp.feed(longLine.data(), 20, onLine, onOverflow);
    const std::string tail = "\nok\n";
    sp.feed(tail.data(), tail.size(), onLine, onOverflow);
    CHECK_EQ(overflows, 1);
    CHECK_EQ(lines.back(), std::string("ok"));
    CHECK(isBlankLine(" \t\r"));
    CHECK(!isBlankLine(" x"));
}
