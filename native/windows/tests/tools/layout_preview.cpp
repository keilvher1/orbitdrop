// Developer tool: rasterises the wheel layout (sector outlines, gaps, rounded
// corners, ring, capsule, highlight, the caption strip with its pill, and the
// hit-test alpha mask) to a PNG with a tiny software rasteriser. No fonts:
// label positions are drawn as dots, and the caption pill is sized for a short
// label ("JPG"). It exists to eyeball src/core/wheel_layout.cpp and the window
// layout on machines without Windows; the real renderer is Direct2D
// (src/win/renderer.cpp).
//
//   orbitdrop-layout-preview out.png [sectors=4] [scale=2] [highlight=-1] [theme=light|dark|hc] [at=middle|bottom]
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "core/coords.h"
#include "core/defaults.h"
#include "core/geometry.h"
#include "core/jsmath.h"
#include "core/wheel_layout.h"

using namespace od;

namespace {

uint32_t crcTable[256];

void initCrc() {
    for (uint32_t n = 0; n < 256; ++n) {
        uint32_t c = n;
        for (int k = 0; k < 8; ++k) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        crcTable[n] = c;
    }
}

uint32_t crc(const uint8_t* p, size_t n, uint32_t c = 0xFFFFFFFFu) {
    for (size_t i = 0; i < n; ++i) c = crcTable[(c ^ p[i]) & 0xFF] ^ (c >> 8);
    return c;
}

void be32(std::vector<uint8_t>& v, uint32_t x) {
    v.push_back(static_cast<uint8_t>(x >> 24));
    v.push_back(static_cast<uint8_t>(x >> 16));
    v.push_back(static_cast<uint8_t>(x >> 8));
    v.push_back(static_cast<uint8_t>(x));
}

void chunk(std::vector<uint8_t>& out, const char* type, const std::vector<uint8_t>& data) {
    be32(out, static_cast<uint32_t>(data.size()));
    std::vector<uint8_t> td(type, type + 4);
    td.insert(td.end(), data.begin(), data.end());
    out.insert(out.end(), td.begin(), td.end());
    be32(out, crc(td.data(), td.size()) ^ 0xFFFFFFFFu);
}

/** Writes straight-alpha RGBA8 as PNG (zlib stored blocks, no compression). */
bool writePng(const std::string& path, int w, int h, const std::vector<uint8_t>& rgba) {
    initCrc();
    std::vector<uint8_t> raw;
    raw.reserve(static_cast<size_t>(h) * (w * 4 + 1));
    for (int y = 0; y < h; ++y) {
        raw.push_back(0);
        raw.insert(raw.end(), rgba.begin() + static_cast<long>(y) * w * 4, rgba.begin() + static_cast<long>(y + 1) * w * 4);
    }
    std::vector<uint8_t> z = {0x78, 0x01};
    uint32_t a = 1, b = 0;
    for (uint8_t c : raw) {
        a = (a + c) % 65521;
        b = (b + a) % 65521;
    }
    size_t pos = 0;
    while (pos < raw.size()) {
        const size_t n = std::min<size_t>(65535, raw.size() - pos);
        z.push_back(pos + n == raw.size() ? 1 : 0);
        z.push_back(static_cast<uint8_t>(n & 0xFF));
        z.push_back(static_cast<uint8_t>(n >> 8));
        z.push_back(static_cast<uint8_t>(~n & 0xFF));
        z.push_back(static_cast<uint8_t>((~n >> 8) & 0xFF));
        z.insert(z.end(), raw.begin() + static_cast<long>(pos), raw.begin() + static_cast<long>(pos + n));
        pos += n;
    }
    be32(z, (b << 16) | a);
    std::vector<uint8_t> png = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
    std::vector<uint8_t> ihdr;
    be32(ihdr, static_cast<uint32_t>(w));
    be32(ihdr, static_cast<uint32_t>(h));
    ihdr.insert(ihdr.end(), {8, 6, 0, 0, 0});
    chunk(png, "IHDR", ihdr);
    chunk(png, "IDAT", z);
    chunk(png, "IEND", {});
    FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) return false;
    const bool ok = std::fwrite(png.data(), 1, png.size(), f) == png.size();
    std::fclose(f);
    return ok;
}

struct RGBA {
    double r, g, b, a;
};

RGBA rgba(const proto::Color& c) { return RGBA{c.r / 255.0, c.g / 255.0, c.b / 255.0, c.a / 255.0}; }

/** Premultiplied source-over. */
void blend(RGBA& dst, const RGBA& src, double coverage) {
    const double a = src.a * coverage;
    dst.r = src.r * a + dst.r * (1 - a);
    dst.g = src.g * a + dst.g * (1 - a);
    dst.b = src.b * a + dst.b * (1 - a);
    dst.a = a + dst.a * (1 - a);
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s out.png [sectors=4] [scale=2] [highlight=-1] [theme=light|dark|hc] [at=middle|bottom]\n", argv[0]);
        return 2;
    }
    const int sectors = argc > 2 ? std::atoi(argv[2]) : 4;
    const double scale = argc > 3 ? std::atof(argv[3]) : 2.0;
    const int highlight = argc > 4 ? std::atoi(argv[4]) : -1;
    const std::string themeName = argc > 5 ? argv[5] : "light";
    const bool atBottom = argc > 6 && std::strcmp(argv[6], "bottom") == 0;  // wheel pushed up: caption above
    const defaults::Theme theme = themeName == "dark" ? defaults::Theme::Dark : themeName == "hc" ? defaults::Theme::HighContrast : defaults::Theme::Light;
    const proto::WheelTokens t = defaults::tokens(theme);
    const geo::WheelGeometry g = geo::kDefaultGeometry;

    coords::Win32Monitor m;
    m.bounds = {0, 0, 4000, 3000};
    m.workArea = m.bounds;
    m.dpi = 96 * scale;
    m.primary = true;
    const auto displays = coords::displaysFromWin32Monitors({m});
    const coords::WheelFrame f = coords::computeWheelFrame(atBottom ? coords::PointI{2000, 2980} : coords::PointI{2000, 1500}, displays, g);
    const layout::Layout L = layout::computeLayout(sectors, f.diameter, g);
    // A highlighted sector shows the caption; its pill is sized for a short label.
    const bool caption = highlight >= 0 && f.panel.captionPlacement != coords::CaptionPlacement::None;
    const geo::Rect pill = coords::captionPillRect(coords::captionStripLocal(f), 27);
    std::vector<std::vector<std::vector<layout::Vec2>>> polys;
    for (const auto& s : L.sectors) {
        std::vector<std::vector<layout::Vec2>> p;
        for (const auto& fig : s.figures) p.push_back(layout::flatten(fig, 2.0));
        polys.push_back(p);
    }

    const geo::Point center = coords::drawCenterPx(f);
    const int w = f.windowPx.width;
    const int h = f.windowPx.height;
    // Checkerboard background shows transparency; magenta marks mask/alpha errors.
    std::vector<uint8_t> out(static_cast<size_t>(w) * h * 4);
    const int ss = 3;
    int maskErrors = 0;
    for (int j = 0; j < h; ++j) {
        for (int i = 0; i < w; ++i) {
            RGBA px{0, 0, 0, 0};
            double cover[7] = {0, 0, 0, 0, 0, 0, 0};  // disc, ring, sector, capsule, active, label, caption pill
            int sectorIndex = -1;
            for (int sy = 0; sy < ss; ++sy) {
                for (int sx = 0; sx < ss; ++sx) {
                    const double lx = (i + (sx + 0.5) / ss - center.x) / f.scale;
                    const double ly = (j + (sy + 0.5) / ss - center.y) / f.scale;
                    const double r = std::sqrt(lx * lx + ly * ly);
                    if (r <= L.outerR) cover[0] += 1;
                    if (std::fabs(r - L.ringR) <= L.ringWidth / 2) cover[1] += 1;
                    const geo::WheelHit hit = geo::hitTestWheel(lx, ly, sectors, f.diameter, g);
                    if (hit.zone == geo::WheelHit::Zone::Sector) {
                        for (int k : {hit.index, (hit.index + 1) % sectors, (hit.index + sectors - 1) % sectors}) {
                            if (layout::containsPoint(polys[static_cast<size_t>(k)], layout::Vec2{lx, ly})) {
                                cover[k == highlight ? 4 : 2] += 1;
                                sectorIndex = k;
                                break;
                            }
                        }
                    }
                    const double cw = L.capsuleWidth / 2 - L.capsuleHeight / 2;
                    const double ddx = std::max(0.0, std::fabs(lx) - cw);
                    if (std::sqrt(ddx * ddx + ly * ly) <= L.capsuleHeight / 2) cover[3] += 1;
                    for (const auto& s : L.sectors) {
                        if (std::hypot(lx - s.labelCenter.x, ly - s.labelCenter.y) <= 3) cover[5] += 1;
                    }
                    if (caption && coords::pillContains(pill, geo::Point{lx, ly})) cover[6] += 1;
                    if (caption && std::hypot(lx - (pill.x + pill.width / 2), ly - (pill.y + pill.height / 2)) <= 3) cover[5] += 1;
                }
            }
            for (double& c : cover) c /= ss * ss;
            blend(px, rgba(t.wheelDisc), cover[0]);
            blend(px, rgba(t.sector), cover[2]);
            blend(px, rgba(t.sectorActive), cover[4]);
            blend(px, rgba(t.wheelRing), cover[1]);
            blend(px, rgba(t.capsule), cover[3]);
            proto::Color opaque = t.capsule;  // the pill is opaque, like the renderer's
            opaque.a = 255;
            blend(px, rgba(opaque), cover[6]);
            blend(px, rgba(t.sectorText), cover[5]);
            // Same alpha floor as the Windows renderer (coords::applyHitShape): alpha >= 1/255
            // on the disc and the caption pill, 0 everywhere else.
            const bool inside = coords::windowPixelInsideDisc(i, j, f) || (caption && coords::windowPixelInsidePill(i, j, f, pill));
            if (inside && px.a < 1.0 / 255) px = RGBA{0, 0, 0, 1.0 / 255};
            if (!inside) px = RGBA{0, 0, 0, 0};
            (void)sectorIndex;
            // Composite over a checkerboard for viewing.
            const double bg = ((i / 8 + j / 8) % 2) ? 0.85 : 0.65;
            RGBA view{bg, bg, bg, 1};
            blend(view, RGBA{px.a > 0 ? px.r / px.a : 0, px.a > 0 ? px.g / px.a : 0, px.a > 0 ? px.b / px.a : 0, px.a}, 1);
            if (inside != (px.a > 0)) {
                ++maskErrors;
                view = RGBA{1, 0, 1, 1};
            }
            uint8_t* o = &out[(static_cast<size_t>(j) * w + i) * 4];
            o[0] = static_cast<uint8_t>(std::lround(std::min(1.0, view.r) * 255));
            o[1] = static_cast<uint8_t>(std::lround(std::min(1.0, view.g) * 255));
            o[2] = static_cast<uint8_t>(std::lround(std::min(1.0, view.b) * 255));
            o[3] = 255;
        }
    }
    if (!writePng(argv[1], w, h, out)) {
        std::fprintf(stderr, "cannot write %s\n", argv[1]);
        return 1;
    }
    const char* placement = f.panel.captionPlacement == coords::CaptionPlacement::Below   ? "below"
                            : f.panel.captionPlacement == coords::CaptionPlacement::Above ? "above"
                                                                                          : "none";
    std::printf("%s: %dx%d px, scale %.2f, %d sectors, corner radius %.2f, caption strip %s%s, mask errors %d\n", argv[1], w, h,
                f.scale, sectors, L.cornerRadius, placement, caption ? " (pill shown)" : "", maskErrors);
    return maskErrors == 0 ? 0 : 1;
}
