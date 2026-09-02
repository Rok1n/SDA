using System.Buffers.Binary;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace SdaAirPodsBridge;

internal static class Program
{
    private static readonly object OutputGate = new();
    private static volatile bool _recenterRequested;
    private static volatile bool _stopRequested;

    public static async Task<int> Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        Emit(new { type = "status", state = "starting" });

        if (!OperatingSystem.IsWindows())
        {
            Emit(new { type = "status", state = "unsupported", message = "Windows is required" });
            return 2;
        }

        var airPods = AirPodsFinder.FindBest();
        if (airPods is null)
        {
            Emit(new { type = "status", state = "airpods-not-found", message = "No remembered AirPods device was found" });
            return 3;
        }

        Emit(new { type = "device", name = airPods.Name, address = airPods.Address, connected = airPods.Connected });

        using var connection = SoundStageInteropDriver.TryOpen(airPods.Address);
        if (!connection.Connected || connection.Client is null)
        {
            Emit(new { type = "status", state = "driver-unavailable", message = connection.Message });
            return 4;
        }

        using var client = connection.Client;
        var parser = new MotionParser();
        var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
        _ = RunCommandLoopAsync(cancellation.Token);

        try
        {
            client.Send(Aacp.CreateHandshake());
            client.Send(Aacp.CreateFeatureFlags());
            client.Send(Aacp.CreateNotificationRequest());
            client.Send(Aacp.CreateOwnsConnection(true));
            await Task.Delay(350, cancellation.Token);
            client.Send(Aacp.CreateAlternateStartHeadTracking());
            Emit(new { type = "status", state = "calibrating", source = "airpods-aacp" });

            var startedAt = DateTimeOffset.UtcNow;
            var fallbackSent = false;
            var lastPoseAt = DateTimeOffset.MinValue;
            float centerYaw = 0;
            float centerPitch = 0;
            var centerSamples = 0;
            float smoothedYaw = 0;
            float smoothedPitch = 0;

            while (!cancellation.IsCancellationRequested && !_stopRequested)
            {
                if (_recenterRequested)
                {
                    _recenterRequested = false;
                    parser.Reset();
                    centerYaw = centerPitch = smoothedYaw = smoothedPitch = 0;
                    centerSamples = 0;
                    Emit(new { type = "status", state = "calibrating", reason = "recenter" });
                }

                byte[] packet;
                try
                {
                    packet = client.Receive();
                }
                catch (Exception ex)
                {
                    Emit(new { type = "status", state = "driver-error", message = ex.Message });
                    return 5;
                }

                if (parser.TryParse(packet, out var frame))
                {
                    const int centerSampleTarget = 12;
                    if (centerSamples < centerSampleTarget)
                    {
                        centerSamples++;
                        centerYaw += WrapDegrees(frame.YawDeg - centerYaw) / centerSamples;
                        centerPitch += (frame.PitchDeg - centerPitch) / centerSamples;
                        smoothedYaw = 0;
                        smoothedPitch = 0;
                        Emit(new { type = "status", state = "calibrating", samples = centerSamples, required = centerSampleTarget });
                    }
                    else
                    {
                        var yaw = WrapDegrees(frame.YawDeg - centerYaw);
                        var pitch = frame.PitchDeg - centerPitch;
                        var yawDelta = WrapDegrees(yaw - smoothedYaw);
                        var pitchDelta = pitch - smoothedPitch;
                        var yawSmoothing = Math.Clamp(0.12f + Math.Abs(yawDelta) * 0.018f, 0.12f, 0.42f);
                        var pitchSmoothing = Math.Clamp(0.11f + Math.Abs(pitchDelta) * 0.016f, 0.11f, 0.34f);
                        smoothedYaw = WrapDegrees(smoothedYaw + yawDelta * yawSmoothing);
                        smoothedPitch += pitchDelta * pitchSmoothing;
                        lastPoseAt = DateTimeOffset.UtcNow;
                        Emit(new
                        {
                            type = "pose",
                            source = "airpods-aacp",
                            state = "live",
                            yawDeg = smoothedYaw,
                            pitchDeg = smoothedPitch,
                            rollDeg = 0.0f,
                            rollValid = false,
                            horizontalAcceleration = frame.HorizontalAcceleration,
                            verticalAcceleration = frame.VerticalAcceleration,
                            timestampUnixMs = lastPoseAt.ToUnixTimeMilliseconds(),
                        });
                    }
                }
                else if (!fallbackSent && DateTimeOffset.UtcNow - startedAt > TimeSpan.FromSeconds(2))
                {
                    fallbackSent = true;
                    client.Send(Aacp.CreateStartHeadTracking());
                }
                else if (lastPoseAt != DateTimeOffset.MinValue && DateTimeOffset.UtcNow - lastPoseAt > TimeSpan.FromSeconds(2))
                {
                    Emit(new { type = "status", state = "stale", message = "Waiting for AirPods motion" });
                    lastPoseAt = DateTimeOffset.UtcNow;
                }

                await Task.Delay(18, cancellation.Token);
            }
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            try { client.Send(Aacp.CreateAlternateStopHeadTracking()); } catch { }
            try { client.Send(Aacp.CreateOwnsConnection(false)); } catch { }
        }

        Emit(new { type = "status", state = "stopped" });
        return 0;
    }

    private static async Task RunCommandLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            string? line;
            try { line = await Console.In.ReadLineAsync(cancellationToken); }
            catch (OperationCanceledException) { return; }
            if (line is null) return;
            line = line.Trim();
            if (line.Length == 0) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var type = doc.RootElement.TryGetProperty("type", out var value) ? value.GetString() : null;
                if (type == "recenter") _recenterRequested = true;
                if (type == "stop") _stopRequested = true;
            }
            catch { }
        }
    }

    private static float WrapDegrees(float value)
    {
        value %= 360f;
        if (value > 180f) value -= 360f;
        if (value < -180f) value += 360f;
        return value;
    }

    private static void Emit(object value)
    {
        lock (OutputGate)
        {
            Console.WriteLine(JsonSerializer.Serialize(value));
            Console.Out.Flush();
        }
    }
}

internal sealed record RememberedAirPods(string Name, string Address, bool Connected, bool Authenticated);

internal static class AirPodsFinder
{
    public static RememberedAirPods? FindBest()
    {
        var candidates = new List<RememberedAirPods>();
        var radioParams = new BluetoothFindRadioParams { Size = Marshal.SizeOf<BluetoothFindRadioParams>() };
        var search = BluetoothFindFirstRadio(ref radioParams, out var radio);
        if (search == IntPtr.Zero) return null;
        try
        {
            do
            {
                try { candidates.AddRange(FindOnRadio(radio)); }
                finally { _ = CloseHandle(radio); }
            }
            while (BluetoothFindNextRadio(search, out radio));
        }
        finally { _ = BluetoothFindRadioClose(search); }

        return candidates.OrderByDescending(x => x.Connected).ThenByDescending(x => x.Authenticated).FirstOrDefault();
    }

    private static IEnumerable<RememberedAirPods> FindOnRadio(nint radio)
    {
        var p = new BluetoothDeviceSearchParams
        {
            Size = Marshal.SizeOf<BluetoothDeviceSearchParams>(),
            ReturnAuthenticated = true,
            ReturnRemembered = true,
            ReturnConnected = true,
            ReturnUnknown = false,
            IssueInquiry = false,
            TimeoutMultiplier = 2,
            RadioHandle = radio,
        };
        var info = NewInfo();
        var search = BluetoothFindFirstDevice(ref p, ref info);
        if (search == IntPtr.Zero) yield break;
        try
        {
            do
            {
                if (!string.IsNullOrWhiteSpace(info.Name) && info.Name.Contains("AirPods", StringComparison.OrdinalIgnoreCase))
                {
                    var hex = info.Address.ToString("X12");
                    var address = string.Join(':', Enumerable.Range(0, 6).Select(i => hex.Substring(i * 2, 2)));
                    yield return new RememberedAirPods(info.Name, address, info.Connected, info.Authenticated);
                }
                info = NewInfo();
            }
            while (BluetoothFindNextDevice(search, ref info));
        }
        finally { _ = BluetoothFindDeviceClose(search); }
    }

    private static BluetoothDeviceInfo NewInfo() => new() { Size = Marshal.SizeOf<BluetoothDeviceInfo>() };

    [StructLayout(LayoutKind.Sequential)] private struct BluetoothFindRadioParams { public int Size; }
    [StructLayout(LayoutKind.Sequential)] private struct BluetoothDeviceSearchParams
    {
        public int Size;
        [MarshalAs(UnmanagedType.Bool)] public bool ReturnAuthenticated;
        [MarshalAs(UnmanagedType.Bool)] public bool ReturnRemembered;
        [MarshalAs(UnmanagedType.Bool)] public bool ReturnUnknown;
        [MarshalAs(UnmanagedType.Bool)] public bool ReturnConnected;
        [MarshalAs(UnmanagedType.Bool)] public bool IssueInquiry;
        public byte TimeoutMultiplier;
        public nint RadioHandle;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct BluetoothDeviceInfo
    {
        public int Size;
        public ulong Address;
        public uint ClassOfDevice;
        [MarshalAs(UnmanagedType.Bool)] public bool Connected;
        [MarshalAs(UnmanagedType.Bool)] public bool Remembered;
        [MarshalAs(UnmanagedType.Bool)] public bool Authenticated;
        private SystemTime LastSeen;
        private SystemTime LastUsed;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 248)] public string Name;
    }
    [StructLayout(LayoutKind.Sequential)] private struct SystemTime
    {
        private ushort Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds;
    }

    [DllImport("BluetoothApis.dll", SetLastError = true)] private static extern nint BluetoothFindFirstRadio(ref BluetoothFindRadioParams p, out nint radio);
    [DllImport("BluetoothApis.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool BluetoothFindNextRadio(nint search, out nint radio);
    [DllImport("BluetoothApis.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool BluetoothFindRadioClose(nint search);
    [DllImport("BluetoothApis.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint BluetoothFindFirstDevice(ref BluetoothDeviceSearchParams p, ref BluetoothDeviceInfo info);
    [DllImport("BluetoothApis.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool BluetoothFindNextDevice(nint search, ref BluetoothDeviceInfo info);
    [DllImport("BluetoothApis.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool BluetoothFindDeviceClose(nint search);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(nint handle);
}

internal sealed record DriverOpenResult(bool Connected, string Message, SoundStageInteropDriver? Client) : IDisposable
{
    public void Dispose() => Client?.Dispose();
}

internal sealed class SoundStageInteropDriver : IDisposable
{
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint FileShareRead = 0x1;
    private const uint FileShareWrite = 0x2;
    private const uint OpenExisting = 3;
    private const uint AacpCapability = 1u << 2;
    private const int MaxPacketLength = 512;
    private const uint IoctlGetBridgeStatus = 0x00222000;
    private const uint IoctlOpenAacpChannel = 0x00222004;
    private const uint IoctlCloseAacpChannel = 0x00222008;
    private const uint IoctlSendAacpPacket = 0x0022200C;
    private const uint IoctlReadAacpPacket = 0x00222010;
    private static readonly Guid InterfaceGuid = new("3E98D13A-B2A5-4C3D-AE1E-8DB4F3D8C1F0");

    private readonly SafeFileHandle _handle;
    private ulong _sessionId;

    private SoundStageInteropDriver(SafeFileHandle handle, ulong sessionId) { _handle = handle; _sessionId = sessionId; }

    public static DriverOpenResult TryOpen(string bluetoothAddress)
    {
        var failures = new List<string>();
        foreach (var devicePath in EnumerateDevicePaths())
        {
            var handle = CreateFileW(devicePath, GenericRead | GenericWrite, FileShareRead | FileShareWrite, 0, OpenExisting, 0, 0);
            if (handle.IsInvalid)
            {
                failures.Add($"CreateFile({devicePath})={Marshal.GetLastWin32Error()}");
                handle.Dispose();
                continue;
            }
            try
            {
                var status = IoControl(handle, IoctlGetBridgeStatus, null, 32);
                var version = BinaryPrimitives.ReadUInt32LittleEndian(status.AsSpan(4));
                var caps = BinaryPrimitives.ReadUInt32LittleEndian(status.AsSpan(8));
                if (version != 1 || (caps & AacpCapability) == 0) throw new IOException($"Incompatible bridge version/capabilities: {version}/0x{caps:X8}");

                var request = new byte[24];
                BinaryPrimitives.WriteUInt32LittleEndian(request, (uint)request.Length);
                var address = Encoding.ASCII.GetBytes(bluetoothAddress);
                if (address.Length > 17) throw new FormatException("Bluetooth address is too long");
                address.CopyTo(request, 4);
                var response = IoControl(handle, IoctlOpenAacpChannel, request, 24);
                var sessionId = BinaryPrimitives.ReadUInt64LittleEndian(response.AsSpan(16));
                if (sessionId == 0) throw new IOException("Driver returned an empty AACP session");
                return new DriverOpenResult(true, "SoundStage AACP bridge connected", new SoundStageInteropDriver(handle, sessionId));
            }
            catch (Exception ex)
            {
                failures.Add($"{devicePath}: {ex.Message}");
                handle.Dispose();
            }
        }
        return new DriverOpenResult(false, failures.Count == 0 ? "SoundStage-compatible AACP driver interface was not found" : string.Join(" | ", failures), null);
    }

    public void Send(ReadOnlySpan<byte> packet)
    {
        if (_sessionId == 0) throw new ObjectDisposedException(nameof(SoundStageInteropDriver));
        if (packet.IsEmpty || packet.Length > MaxPacketLength) throw new ArgumentOutOfRangeException(nameof(packet));
        var request = new byte[536];
        BinaryPrimitives.WriteUInt32LittleEndian(request, (uint)request.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(request.AsSpan(4), (uint)packet.Length);
        BinaryPrimitives.WriteUInt64LittleEndian(request.AsSpan(16), _sessionId);
        packet.CopyTo(request.AsSpan(24));
        _ = IoControl(_handle, IoctlSendAacpPacket, request, 0);
    }

    public byte[] Receive()
    {
        if (_sessionId == 0) throw new ObjectDisposedException(nameof(SoundStageInteropDriver));
        var request = new byte[24];
        BinaryPrimitives.WriteUInt32LittleEndian(request, (uint)request.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(request.AsSpan(4), MaxPacketLength);
        BinaryPrimitives.WriteUInt64LittleEndian(request.AsSpan(16), _sessionId);
        var response = IoControl(_handle, IoctlReadAacpPacket, request, 528);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(response.AsSpan(4));
        if (length > MaxPacketLength) throw new IOException("Driver returned an oversized AACP packet");
        return response.AsSpan(16, (int)length).ToArray();
    }

    public void Dispose()
    {
        if (_sessionId != 0 && !_handle.IsInvalid && !_handle.IsClosed)
        {
            try
            {
                var request = new byte[16];
                BinaryPrimitives.WriteUInt32LittleEndian(request, (uint)request.Length);
                BinaryPrimitives.WriteUInt64LittleEndian(request.AsSpan(8), _sessionId);
                _ = IoControl(_handle, IoctlCloseAacpChannel, request, 0);
            }
            catch { }
            _sessionId = 0;
        }
        _handle.Dispose();
    }

    private static IReadOnlyList<string> EnumerateDevicePaths()
    {
        var guid = InterfaceGuid;
        if (CM_Get_Device_Interface_List_SizeW(out var chars, ref guid, null, 0) != 0 || chars <= 1) return [];
        var buffer = new char[chars];
        if (CM_Get_Device_Interface_ListW(ref guid, null, buffer, chars, 0) != 0) return [];
        return new string(buffer).Split('\0', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    private static byte[] IoControl(SafeFileHandle handle, uint code, byte[]? input, int outputLength)
    {
        var output = outputLength == 0 ? null : new byte[outputLength];
        if (!DeviceIoControl(handle, code, input, input?.Length ?? 0, output, output?.Length ?? 0, out var returned, 0))
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"DeviceIoControl 0x{code:X8} failed");
        if (output is not null && returned > output.Length) throw new IOException("Driver response exceeded buffer");
        return output ?? [];
    }

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] private static extern uint CM_Get_Device_Interface_List_SizeW(out uint bufferLength, ref Guid interfaceClassGuid, string? deviceId, uint flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] private static extern uint CM_Get_Device_Interface_ListW(ref Guid interfaceClassGuid, string? deviceId, [Out] char[] buffer, uint bufferLength, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string fileName, uint desiredAccess, uint shareMode, nint securityAttributes, uint creationDisposition, uint flagsAndAttributes, nint templateFile);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DeviceIoControl(SafeFileHandle device, uint code, byte[]? inputBuffer, int inputSize, [Out] byte[]? outputBuffer, int outputSize, out int bytesReturned, nint overlapped);
}

internal static class Aacp
{
    private static readonly byte[] Header = [0x04, 0x00, 0x04, 0x00];
    public static byte[] CreateHandshake() => Convert.FromHexString("00000400010002000000000000000000");
    public static byte[] CreateFeatureFlags() => Convert.FromHexString("040004004D00D700000000000000");
    public static byte[] CreateNotificationRequest() => Convert.FromHexString("040004000F00FFFFFFFFFF");
    public static byte[] CreateOwnsConnection(bool enabled) => Data([0x09, 0x00, 0x06, enabled ? (byte)0x01 : (byte)0x00, 0x00, 0x00, 0x00]);
    public static byte[] CreateStartHeadTracking() => Data([0x17,0x00,0x00,0x00,0x10,0x00,0x10,0x00,0x08,0xA1,0x02,0x42,0x0B,0x08,0x0E,0x10,0x02,0x1A,0x05,0x01,0x40,0x9C,0x00,0x00]);
    public static byte[] CreateAlternateStartHeadTracking() => Data([0x17,0x00,0x00,0x00,0x10,0x00,0x0F,0x00,0x08,0x73,0x42,0x0B,0x08,0x10,0x10,0x02,0x1A,0x05,0x01,0x40,0x9C,0x00,0x00]);
    public static byte[] CreateAlternateStopHeadTracking() => Data([0x17,0x00,0x00,0x00,0x10,0x00,0x0F,0x00,0x08,0x75,0x42,0x0B,0x08,0x10,0x10,0x02,0x1A,0x05,0x01,0x00,0x00,0x00,0x00]);
    private static byte[] Data(ReadOnlySpan<byte> data) { var packet = new byte[Header.Length + data.Length]; Header.CopyTo(packet, 0); data.CopyTo(packet.AsSpan(Header.Length)); return packet; }
}

internal readonly record struct MotionFrame(float PitchDeg, float YawDeg, short HorizontalAcceleration, short VerticalAcceleration);

internal sealed class MotionParser
{
    private readonly List<(short O1, short O2, short O3)> _calibration = [];
    private float _neutral1, _neutral2, _neutral3;
    public void Reset() { _calibration.Clear(); _neutral1 = _neutral2 = _neutral3 = 0; }

    public bool TryParse(ReadOnlySpan<byte> packet, out MotionFrame frame)
    {
        frame = default;
        if (packet.Length <= 60) return false;
        ReadOnlySpan<byte> prefix = [0x04,0x00,0x04,0x00,0x17,0x00,0x00,0x00,0x10,0x00];
        if (!packet[..10].SequenceEqual(prefix) || (packet[10] != 0x44 && packet[10] != 0x45) || packet[11] != 0x00) return false;
        var o1 = BinaryPrimitives.ReadInt16LittleEndian(packet[43..45]);
        var o2 = BinaryPrimitives.ReadInt16LittleEndian(packet[45..47]);
        var o3 = BinaryPrimitives.ReadInt16LittleEndian(packet[47..49]);
        var horizontal = BinaryPrimitives.ReadInt16LittleEndian(packet[51..53]);
        var vertical = BinaryPrimitives.ReadInt16LittleEndian(packet[53..55]);
        if (_calibration.Count < 10)
        {
            _calibration.Add((o1,o2,o3));
            if (_calibration.Count < 10) return false;
            _neutral1 = _calibration.Average(s => (float)s.O1);
            _neutral2 = _calibration.Average(s => (float)s.O2);
            _neutral3 = _calibration.Average(s => (float)s.O3);
        }
        _ = o1 - _neutral1;
        var n2 = o2 - _neutral2;
        var n3 = o3 - _neutral3;
        var pitch = (n2 + n3) * 0.5f / 32000f * 180f;
        var yaw = (n2 - n3) * 0.5f / 32000f * 180f;
        frame = new MotionFrame(pitch, yaw, horizontal, vertical);
        return true;
    }
}
