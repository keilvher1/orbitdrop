#include <cstdint>
#include <initializer_list>
#include <string>
#include <utility>
#include <vector>

#include "core/defaults.h"
#include "core/selection.h"
#include "test_framework.h"

using namespace od;
using selection::DragPayload;
using selection::Unsupported;

namespace {

using Map = std::vector<std::pair<std::string, std::string>>;

std::string keyOrNull(const std::optional<proto::MenuKey>& k) { return k ? proto::toString(*k) : "null"; }

DragPayload files(std::vector<std::string> paths) {
    DragPayload p;
    p.hasFileList = true;
    p.totalCount = paths.size();
    p.paths = std::move(paths);
    return p;
}

}  // namespace

TEST_CASE("selection: file names and extensions follow selection.ts") {
    CHECK_EQ(std::string(selection::fileNameOfPath("a.PnG")), std::string("a.PnG"));
    CHECK_EQ(std::string(selection::fileNameOfPath("dir.d/file")), std::string("file"));
    CHECK_EQ(std::string(selection::fileNameOfPath("C:\\photos\\")), std::string("photos"));
    CHECK_EQ(std::string(selection::fileNameOfPath("no/sep\\mix.JpEg")), std::string("mix.JpEg"));
    CHECK_EQ(std::string(selection::fileNameOfPath("\\\\")), std::string(""));
    CHECK_EQ(selection::extensionOfPath("a.PnG"), std::string(".png"));
    CHECK_EQ(selection::extensionOfPath("dir.d/file"), std::string(""));
    CHECK_EQ(selection::extensionOfPath("C:\\x\\y.tar.gz"), std::string(".gz"));
    CHECK_EQ(selection::extensionOfPath(".hidden"), std::string(""));
    CHECK_EQ(selection::extensionOfPath("trail."), std::string(""));
    CHECK_EQ(selection::extensionOfPath("C:\\photos\\"), std::string(""));
    CHECK_EQ(selection::extensionOfPath("no/sep\\mix.JpEg"), std::string(".jpeg"));
    CHECK_EQ(selection::extensionOfPath("\xC3\xBCn\xC3\xAF.JPG"), std::string(".jpg"));       // ünï.JPG
    CHECK_EQ(selection::extensionOfPath("a.\xC3\x84"), std::string(".\xC3\x84"));             // a.Ä (ASCII-only lowering)
}

TEST_CASE("selection: menuKeyForPaths matches the reference") {
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"C:\\a\\Page 001.pdf"}, Map{{".pdf", "pdf"}})), std::string("pdf"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"C:\\a\\x.JPG", "D:/b/y.jpeg"}, Map{{".jpg", "image/jpeg"}, {".jpeg", "image/jpeg"}})),
             std::string("image/jpeg"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"C:\\a\\x.jpg", "C:\\a\\y.png"}, Map{{".jpg", "image/jpeg"}, {".png", "image/png"}})),
             std::string("images"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"C:\\a\\x.pdf", "C:\\a\\y.png"}, Map{{".pdf", "pdf"}, {".png", "image/png"}})),
             std::string("mixed"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"C:\\a\\.png"}, Map{{".png", "image/png"}})), std::string("null"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"C:\\a\\photo."}, Map{{".png", "image/png"}})), std::string("null"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"C:\\a\\folder\\"}, Map{{".png", "image/png"}})), std::string("null"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({}, Map{{".png", "image/png"}})), std::string("null"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({""}, Map{{".png", "image/png"}})), std::string("null"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"C:\\a\\x.png"}, Map{{".png", "images"}})), std::string("null"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"C:\\a\\x.png"}, Map{{".png", "image/xyz"}})), std::string("null"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"C:\\a.b\\noext"}, Map{{".b", "pdf"}})), std::string("null"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"x.tar.GZ"}, Map{{".gz", "pdf"}})), std::string("pdf"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"a.gif", "b.GIF"}, Map{{".gif", "image/gif"}})), std::string("image/gif"));
    CHECK_EQ(keyOrNull(selection::menuKeyForPaths({"a.pdf", "b.txt"}, Map{{".pdf", "pdf"}})), std::string("null"));
}

TEST_CASE("selection: classify payloads against the configuration") {
    const auto cfg = defaults::referenceConfigure();
    auto c = selection::classify(files({"C:\\Users\\me\\Page 001.pdf"}), *cfg);
    CHECK(c.supported);
    CHECK(c.menuKey == proto::MenuKey::Pdf);
    CHECK_EQ(c.fileCount, size_t{1});

    c = selection::classify(files({"C:\\a.jpg", "C:\\b.JPEG"}), *cfg);
    CHECK(c.supported);
    CHECK(c.menuKey == proto::MenuKey::ImageJpeg);
    CHECK_EQ(c.fileCount, size_t{2});

    c = selection::classify(files({"C:\\notes.txt"}), *cfg);
    CHECK(!c.supported);
    CHECK(c.reason == Unsupported::UnknownType);
    CHECK(!c.menuKey);

    DragPayload text;  // a text/URL drag: no CF_HDROP
    c = selection::classify(text, *cfg);
    CHECK(c.reason == Unsupported::NoFiles);

    DragPayload virt;
    virt.virtualFilesOnly = true;
    c = selection::classify(virt, *cfg);
    CHECK(c.reason == Unsupported::VirtualFiles);

    DragPayload many;
    many.hasFileList = true;
    many.totalCount = proto::kMaxFiles + 1;
    c = selection::classify(many, *cfg);
    CHECK(c.reason == Unsupported::TooManyFiles);
    CHECK_EQ(c.fileCount, proto::kMaxFiles + 1);

    DragPayload bad = files({"C:\\x.png"});
    bad.badPath = true;
    CHECK(selection::classify(bad, *cfg).reason == Unsupported::BadPath);

    DragPayload dir = files({"C:\\folder.png"});
    dir.containsDirectory = true;
    c = selection::classify(dir, *cfg);
    CHECK(c.reason == Unsupported::Directory);
    CHECK(!c.menuKey);

    DragPayload huge = files(std::vector<std::string>(40, "C:\\" + std::string(30000, 'p') + ".png"));
    CHECK(selection::classify(huge, *cfg).reason == Unsupported::PayloadTooLarge);

    auto noMenus = std::make_shared<proto::Configure>(*cfg);
    noMenus->menus.clear();
    c = selection::classify(files({"C:\\x.png"}), *noMenus);
    CHECK(c.reason == Unsupported::NoMenu);
    CHECK(c.menuKey == proto::MenuKey::ImagePng);
}

TEST_CASE("selection: file attributes → folder / cloud-only placeholder") {
    const auto of = [](std::initializer_list<uint32_t> attrs) {
        selection::PathFacts f;
        for (const uint32_t a : attrs) selection::addFileAttributes(f, a);
        return f;
    };
    auto f = of({selection::kInvalidFileAttributes});  // gone / no access: main decides
    CHECK(!f.containsDirectory);
    CHECK(!f.containsCloudPlaceholder);
    f = of({0x20});  // FILE_ATTRIBUTE_ARCHIVE: an ordinary local file
    CHECK(!f.containsDirectory);
    CHECK(!f.containsCloudPlaceholder);
    f = of({0x10});
    CHECK(f.containsDirectory);
    f = of({0x10 | 0x00400000});  // a cloud folder is a folder
    CHECK(f.containsDirectory);
    CHECK(!f.containsCloudPlaceholder);
    // OneDrive online-only file: RECALL_ON_DATA_ACCESS | UNPINNED | OFFLINE | REPARSE_POINT | SPARSE | ARCHIVE.
    f = of({0x00501620});
    CHECK(f.containsCloudPlaceholder);
    CHECK(!f.containsDirectory);
    CHECK(of({0x00400020}).containsCloudPlaceholder);  // RECALL_ON_DATA_ACCESS alone
    CHECK(of({0x00001020}).containsCloudPlaceholder);  // OFFLINE (HSM / remote storage)
    CHECK(!of({0x00080420}).containsCloudPlaceholder);  // PINNED ("always keep on this device")
    CHECK(!of({0x00100620}).containsCloudPlaceholder);  // UNPINNED but still local
    CHECK(!of({0x00040020}).containsCloudPlaceholder);  // 0x40000 = FILE_ATTRIBUTE_EA here, not RECALL_ON_OPEN
    CHECK(!of({0x00000420}).containsCloudPlaceholder);  // a symbolic link / other reparse point
    f = of({0x20, 0x00501620, 0x10});  // several paths accumulate
    CHECK(f.containsCloudPlaceholder);
    CHECK(f.containsDirectory);
}

TEST_CASE("selection: multi-file drags disable non-batch sectors") {
    const auto cfg = defaults::referenceConfigure();
    const auto& tools = cfg->findMenu(proto::MenuKey::ImageJpeg)->tools;
    auto one = selection::adjustForFileCount(tools, 1, "single");
    for (const auto& s : one) CHECK(s.enabled);
    auto two = selection::adjustForFileCount(tools, 2, "single");
    REQUIRE(two.size() == 7);
    CHECK(two[0].enabled);   // COMPRESS (batch)
    CHECK(two[1].enabled);   // METADATA (batch)
    CHECK(!two[2].enabled);  // EDIT
    CHECK(two[2].reason == std::optional<std::string>("single"));
    CHECK(!two[5].enabled);  // CROP
    // A sector disabled for capability reasons keeps its own reason.
    auto disabled = tools;
    disabled[5].enabled = false;
    disabled[5].reason = "no engine";
    auto adj = selection::adjustForFileCount(disabled, 3, "single");
    CHECK(adj[5].reason == std::optional<std::string>("no engine"));
}
