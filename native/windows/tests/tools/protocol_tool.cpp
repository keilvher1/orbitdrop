// Developer tool for cross-checking the C++ protocol code against the zod
// schemas in packages/contracts (see tests/tools/protocol-parity.mjs).
//
//   orbitdrop-protocol-tool configure [en|ko] [light|dark|hc]   reference configure line
//   orbitdrop-protocol-tool parse                              stdin lines → "ok <type>" | "reject <code>"
//   orbitdrop-protocol-tool samples                            helper → main sample lines
#include <cstdio>
#include <iostream>
#include <string>
#include <variant>
#include <vector>

#include "core/defaults.h"
#include "core/protocol.h"

using namespace od;

namespace {

const char* typeOf(const proto::MainToHelper& m) {
    if (std::holds_alternative<std::shared_ptr<const proto::Configure>>(m)) return "configure";
    if (std::holds_alternative<proto::CancelSession>(m)) return "cancelSession";
    if (std::holds_alternative<proto::Ping>(m)) return "ping";
    if (std::holds_alternative<proto::Shutdown>(m)) return "shutdown";
    return "queryPermissions";
}

void emit(const std::string& line) {
    if (line.empty()) {
        std::fprintf(stderr, "serializer refused a sample\n");
        return;
    }
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fputc('\n', stdout);
}

int samples() {
    proto::ReadyInfo r;
    r.helperVersion = ORBITDROP_HELPER_VERSION;
    r.arch = "x64";
    r.osVersion = "10.0.26100";
    r.pid = 4321;
    emit(proto::serializeReady(r));
    r.globalDragAvailable = false;
    r.globalDragReason = std::string(250, 'r');  // truncated to 200
    r.helperVersion = std::string(40, '9');     // truncated to 32
    r.osVersion = std::string(80, 'o');         // truncated to 64
    emit(proto::serializeReady(r));

    for (int s = 0; s < 4; ++s) {
        proto::StateMessage st;
        st.sessionId = "w1a2b-3f9c0d12ab-" + std::to_string(s + 1);
        st.state = static_cast<proto::SessionState>(s);
        if (st.state == proto::SessionState::AwaitingPayload || st.state == proto::SessionState::WheelActive) {
            st.mode = s % 2 ? proto::WheelMode::Convert : proto::WheelMode::Tools;
        }
        if (st.state == proto::SessionState::WheelActive) {
            st.hasMenuKey = true;
            st.fileCount = 200;
            emit(proto::serializeState(st));  // menuKey null
            st.menuKey = proto::MenuKey::ImageHeic;
        }
        emit(proto::serializeState(st));
    }
    for (size_t k = 0; k < proto::kMenuKeyCount; ++k) {
        proto::StateMessage st;
        st.sessionId = std::string(64, 'k');
        st.state = proto::SessionState::WheelActive;
        st.mode = proto::WheelMode::Convert;
        st.hasMenuKey = true;
        st.menuKey = static_cast<proto::MenuKey>(k);
        st.fileCount = 1000000;  // clamped to 100000
        emit(proto::serializeState(st));
    }

    proto::DropMessage d;
    d.sessionId = "w1a2b-3f9c0d12ab-7";
    d.mode = proto::WheelMode::Tools;
    d.actionId = proto::ActionId::ToolAddBackground;
    d.files = {"C:\\Users\\\xED\x95\x9C\xEA\xB8\x80\\Page 001.pdf",
               "\\\\server\\share\\a \"quoted\" \xF0\x9F\x98\x80.png",
               "D:\\tab\there\\new\nline\\x.jpg",
               "C:\\" + std::string(32764, 'p')};
    emit(proto::serializeDrop(d));
    for (size_t a = 0; a < proto::kActionCount; ++a) {
        d.actionId = static_cast<proto::ActionId>(a);
        d.files = {"C:\\x.png"};
        emit(proto::serializeDrop(d));
    }
    d.files.assign(proto::kMaxFiles, "C:\\Users\\me\\Pictures\\photo.jpg");
    emit(proto::serializeDrop(d));

    for (int c = 0; c <= static_cast<int>(proto::CancelReason::Error); ++c) {
        emit(proto::serializeCancelled("w1a2b-3f9c0d12ab-9", static_cast<proto::CancelReason>(c)));
    }
    emit(proto::serializePong(0));
    emit(proto::serializePong(proto::kMaxSafeInteger));
    emit(proto::serializePermissions());
    for (int l = 0; l < 4; ++l) emit(proto::serializeLog(static_cast<proto::LogLevel>(l), std::string(3000, 'm')));
    emit(proto::serializeLog(proto::LogLevel::Info, "\xF0\x9F\x98\x80 emoji \"quotes\" \\ back\x01slash"));
    emit(proto::serializeError("invalidJson", "rejected message: unexpected character at byte 0", false));
    emit(proto::serializeError(std::string(100, 'c'), std::string(2500, 'e'), true));
    return 0;
}

int parse() {
    std::string line;
    while (std::getline(std::cin, line)) {
        const proto::ParseResult r = proto::parseMainToHelper(line);
        if (r.ok()) {
            std::printf("ok %s\n", typeOf(*r.message));
        } else {
            std::printf("reject %s\n", proto::errorCodeFor(r.failure.kind));
        }
    }
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    const std::string cmd = argc > 1 ? argv[1] : "";
    if (cmd == "samples") return samples();
    if (cmd == "parse") return parse();
    if (cmd == "configure") {
        const std::string loc = argc > 2 ? argv[2] : "en";
        const std::string theme = argc > 3 ? argv[3] : "light";
        const auto cfg = defaults::referenceConfigure(loc == "ko" ? proto::Locale::Ko : proto::Locale::En,
                                                      theme == "dark" ? defaults::Theme::Dark
                                                      : theme == "hc" ? defaults::Theme::HighContrast
                                                                      : defaults::Theme::Light);
        std::printf("%s\n", defaults::configureToJson(*cfg).c_str());
        return 0;
    }
    std::fprintf(stderr, "usage: %s configure [en|ko] [light|dark|hc] | parse | samples\n", argv[0]);
    return 2;
}
