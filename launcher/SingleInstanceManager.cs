using Avalonia.Threading;
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Launcher;

public static class SingleInstanceManager
{
    private const string SignalMessage = "show-logs";
    private static readonly string InstanceKey = CreateInstanceKey();
    private static readonly string MutexName = $"Yamibunko.Launcher.{InstanceKey}";
    private static readonly string PipeName = $"yamibunko-launcher-{InstanceKey}";

    private static Mutex? _mutex;
    private static CancellationTokenSource? _listenCancellation;
    private static Task? _listenTask;
    private static Action? _showLogsWindow;

    public static bool TryAcquireOrSignalExisting()
    {
        _mutex = new Mutex(true, MutexName, out var createdNew);
        if (createdNew)
        {
            return true;
        }

        _mutex.Dispose();
        _mutex = null;
        SignalExistingInstance();
        return false;
    }

    public static void StartListening(Action showLogsWindow)
    {
        _showLogsWindow = showLogsWindow;

        if (_listenCancellation != null)
        {
            return;
        }

        _listenCancellation = new CancellationTokenSource();
        _listenTask = Task.Run(() => ListenAsync(_listenCancellation.Token));
    }

    public static void Shutdown()
    {
        var listenCancellation = Interlocked.Exchange(ref _listenCancellation, null);
        if (listenCancellation != null)
        {
            try
            {
                listenCancellation.Cancel();
            }
            catch
            {
            }
            finally
            {
                listenCancellation.Dispose();
            }
        }

        _listenTask = null;
        _showLogsWindow = null;

        var mutex = Interlocked.Exchange(ref _mutex, null);
        if (mutex == null)
        {
            return;
        }

        try
        {
            mutex.ReleaseMutex();
        }
        catch (ApplicationException)
        {
        }
        finally
        {
            mutex.Dispose();
        }
    }

    private static async Task ListenAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await using var pipe = new NamedPipeServerStream(
                    PipeName,
                    PipeDirection.In,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                await pipe.WaitForConnectionAsync(cancellationToken);

                using var reader = new StreamReader(pipe, Encoding.UTF8, false, leaveOpen: true);
                var message = await reader.ReadLineAsync(cancellationToken);
                if (string.Equals(message, SignalMessage, StringComparison.Ordinal))
                {
                    RequestShowLogsWindow();
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"Single instance listener failed: {ex.Message}");

                try
                {
                    await Task.Delay(250, cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }
    }

    private static void SignalExistingInstance()
    {
        var deadline = DateTime.UtcNow.AddSeconds(4);

        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
                pipe.Connect(250);

                using var writer = new StreamWriter(pipe, Encoding.UTF8) { AutoFlush = true };
                writer.WriteLine(SignalMessage);
                return;
            }
            catch (TimeoutException)
            {
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }

            Thread.Sleep(100);
        }
    }

    private static void RequestShowLogsWindow()
    {
        var showLogsWindow = _showLogsWindow;
        if (showLogsWindow == null)
        {
            return;
        }

        Dispatcher.UIThread.Post(showLogsWindow);
    }

    private static string CreateInstanceKey()
    {
        var baseDirectory = Path.GetFullPath(AppContext.BaseDirectory)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            .ToUpperInvariant();
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(baseDirectory));
        return Convert.ToHexString(hash.AsSpan(0, 8)).ToLowerInvariant();
    }
}
