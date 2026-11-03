import { describe, it, expect } from "vitest";
import { ffmpegRtspArgs, encoderName } from "../src/dashboard/camera/rtsp.js";
import { loadConfig } from "../src/shared/config.js";
import type { Config } from "../src/shared/config.js";

function cfg(over: Record<string, string> = {}): Config {
  return loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx", ...over });
}
const idx = (a: string[], f: string): number => a.indexOf(f);

describe("ffmpegRtspArgs — ordering invariants", () => {
  it("puts every v4l2 input option BEFORE -i", () => {
    const a = ffmpegRtspArgs(cfg());
    const i = idx(a, "-i");
    expect(i).toBeGreaterThan(-1);
    for (const flag of ["-f", "-input_format", "-video_size", "-framerate"]) {
      expect(idx(a, flag)).toBeLessThan(i);
    }
  });

  it("puts vulkan hw-device init BEFORE -i", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "vulkan" }));
    expect(idx(a, "-init_hw_device")).toBeLessThan(idx(a, "-i"));
    expect(idx(a, "-filter_hw_device")).toBeLessThan(idx(a, "-i"));
  });

  it("puts the GOP/keyframe options AFTER -i for every encoding branch", () => {
    for (const encoder of ["nvenc", "vulkan", "x264"]) {
      const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: encoder }));
      const i = idx(a, "-i");
      expect(idx(a, "-g")).toBeGreaterThan(i);
      expect(idx(a, "-bsf:v")).toBeGreaterThan(i);
    }
  });

  it("puts the RTSP target last", () => {
    const a = ffmpegRtspArgs(cfg());
    expect(a[a.length - 1]).toBe("rtsp://127.0.0.1:8554/tb3");
    expect(a[a.length - 3]).toBe("-rtsp_transport");   // -f rtsp -rtsp_transport tcp <url>
  });
});

describe("ffmpegRtspArgs — encoder selection", () => {
  it("vulkan uses hwupload and never -pix_fmt yuv420p", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "vulkan" }));
    expect(a).toContain("h264_vulkan");
    expect(a).toContain("format=nv12,hwupload");
    expect(a).not.toContain("yuv420p");
  });

  it("nvenc uses -pix_fmt yuv420p and no vulkan device", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "nvenc" }));
    expect(a).toContain("h264_nvenc");
    expect(a).toContain("yuv420p");
    expect(a).not.toContain("-init_hw_device");
    expect(a).not.toContain("format=nv12,hwupload");
  });

  it("x264 uses libx264 with a low-latency preset", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "x264" }));
    expect(a).toContain("libx264");
    expect(a).toContain("veryfast");
    expect(a).toContain("yuv420p");
    expect(a).not.toContain("-init_hw_device");
  });

  it("copy passes through and sets no bitrate", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "copy" }));
    expect(a).toContain("copy");
    expect(a).not.toContain("-b:v");
  });

  it("copy gains no encoder-only GOP/keyframe flags (it never touches the frames)", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "copy" }));
    expect(a).not.toContain("-g");
    expect(a).not.toContain("-bsf:v");
    expect(a).not.toContain("-forced-idr");
  });

  it("encoderName maps config to the ffmpeg encoder id", () => {
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "vulkan" }))).toBe("h264_vulkan");
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "nvenc" }))).toBe("h264_nvenc");
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "x264" }))).toBe("libx264");
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "copy" }))).toBeNull();
  });
});

describe("ffmpegRtspArgs — GOP/keyframe options (mid-stream WebRTC join fix)", () => {
  // A joining WebRTC viewer never gets a decodable stream without a short
  // GOP and in-band SPS/PPS -- see the block comment on ffmpegRtspArgs.
  for (const encoder of ["nvenc", "vulkan", "x264"]) {
    it(`${encoder} sets a GOP size and repeats SPS/PPS in-band at every keyframe`, () => {
      const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: encoder }));
      expect(idx(a, "-g")).toBeGreaterThan(-1);
      expect(a[idx(a, "-bsf:v") + 1]).toBe("dump_extra=freq=keyframe");
    });
  }

  it("GOP size tracks cameraV4l2Framerate at 30fps (~2s of frames)", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "nvenc", TB3_CAMERA_V4L2_FRAMERATE: "30" }));
    expect(a[idx(a, "-g") + 1]).toBe("60");
  });

  it("GOP size tracks cameraV4l2Framerate at 15fps (~2s of frames)", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "nvenc", TB3_CAMERA_V4L2_FRAMERATE: "15" }));
    expect(a[idx(a, "-g") + 1]).toBe("30");
  });

  it("nvenc forces genuine IDR frames for forced keyframes", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "nvenc" }));
    expect(a[idx(a, "-forced-idr") + 1]).toBe("1");
  });

  it("vulkan and x264 do not set the NVENC-only -forced-idr option", () => {
    for (const encoder of ["vulkan", "x264"]) {
      const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: encoder }));
      expect(a).not.toContain("-forced-idr");
    }
  });
});

describe("ffmpegRtspArgs — plumbing", () => {
  it("uses cameraMediamtxSize, NOT cameraV4l2Size", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_MEDIAMTX_SIZE: "3840x2160", TB3_CAMERA_V4L2_SIZE: "640x480" }));
    expect(a[idx(a, "-video_size") + 1]).toBe("3840x2160");
  });

  it("plumbs device, framerate, bitrate and target", () => {
    const a = ffmpegRtspArgs(cfg({
      TB3_CAMERA_ENCODER: "x264",   // vaapi (the default) is CQP and takes no -b:v
      TB3_CAMERA_V4L2_DEVICE: "/dev/v4l/by-id/usb-4K_USB_Camera-video-index0",
      TB3_CAMERA_V4L2_FRAMERATE: "25",
      TB3_CAMERA_VIDEO_BITRATE: "12M",
      TB3_CAMERA_MEDIAMTX_RTSP_URL: "rtsp://127.0.0.1:8554/cam2",
    }));
    expect(a[idx(a, "-i") + 1]).toBe("/dev/v4l/by-id/usb-4K_USB_Camera-video-index0");
    expect(a[idx(a, "-framerate") + 1]).toBe("25");
    expect(a[idx(a, "-b:v") + 1]).toBe("12M");
    expect(a[a.length - 1]).toBe("rtsp://127.0.0.1:8554/cam2");
  });

  it("requests MJPEG input (the camera has no native H.264)", () => {
    const a = ffmpegRtspArgs(cfg());
    expect(a[idx(a, "-input_format") + 1]).toBe("mjpeg");
  });
});

describe("ffmpegRtspArgs — vaapi", () => {
  const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "vaapi" }));

  it("encoderName maps vaapi to h264_vaapi", () => {
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "vaapi" }))).toBe("h264_vaapi");
  });

  it("puts -vaapi_device before -i, defaulting to renderD128", () => {
    expect(a[idx(a, "-vaapi_device") + 1]).toBe("/dev/dri/renderD128");
    expect(idx(a, "-vaapi_device")).toBeLessThan(idx(a, "-i"));
  });

  it("honours TB3_CAMERA_VAAPI_DEVICE", () => {
    const b = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "vaapi", TB3_CAMERA_VAAPI_DEVICE: "/dev/dri/renderD129" }));
    expect(b[idx(b, "-vaapi_device") + 1]).toBe("/dev/dri/renderD129");
  });

  it("uploads nv12 after the input then encodes CQP 23 without B-frames, in order", () => {
    const i = idx(a, "-i");
    const vf = idx(a, "-vf");
    expect(vf).toBeGreaterThan(i);
    expect(a[vf + 1]).toBe("format=nv12,hwupload");
    expect(a.slice(vf + 2, vf + 10)).toEqual(["-c:v", "h264_vaapi", "-rc_mode", "CQP", "-qp", "23", "-bf", "0"]);
  });

  it("keeps the keyframe args and the shared rtsp tail, and no software-encoder flags", () => {
    expect(a[idx(a, "-bsf:v") + 1]).toBe("dump_extra=freq=keyframe");
    expect(idx(a, "-g")).toBeGreaterThan(idx(a, "-i"));
    expect(a.slice(-5)).toEqual(["-f", "rtsp", "-rtsp_transport", "tcp", "rtsp://127.0.0.1:8554/tb3"]);
    expect(a).not.toContain("-pix_fmt");
    expect(a).not.toContain("-init_hw_device");
  });
});

describe("ffmpegRtspArgs — existing branches are pinned (snapshot)", () => {
  const base = ["-hide_banner", "-loglevel", "error", "-f", "v4l2", "-input_format", "mjpeg",
    "-video_size", "1920x1080", "-framerate", "30", "-i", "/dev/video0"];
  const kf = ["-g", "60", "-bsf:v", "dump_extra=freq=keyframe"];
  const tail = ["-f", "rtsp", "-rtsp_transport", "tcp", "rtsp://127.0.0.1:8554/tb3"];
  const get = (e: string) => ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: e }));

  it("nvenc", () => expect(get("nvenc")).toEqual([...base,
    "-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-b:v", "6M", "-pix_fmt", "yuv420p", ...kf, "-forced-idr", "1", ...tail]));
  it("x264", () => expect(get("x264")).toEqual([...base,
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-b:v", "6M", "-pix_fmt", "yuv420p", ...kf, ...tail]));
  it("copy", () => expect(get("copy")).toEqual([...base, "-c:v", "copy", ...tail]));
  it("vulkan", () => expect(get("vulkan")).toEqual([
    "-hide_banner", "-loglevel", "error", "-init_hw_device", "vulkan=vk:0", "-filter_hw_device", "vk", ...base.slice(3),
    "-vf", "format=nv12,hwupload", "-c:v", "h264_vulkan", "-b:v", "6M", ...kf, ...tail]));
});
