// SPDX-License-Identifier: MIT
using System;
using System.Diagnostics;
using System.Threading;

static class CodexFixture
{
    static int Main(string[] args)
    {
        if (args.Length == 3 && args[0] == "--no-daemon" && args[1] == "resume")
        {
            Console.WriteLine("Restored " + args[2]);
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }

        Guid session;
        if (args.Length != 2 || !Guid.TryParseExact(args[0], "D", out session))
            return 2;

        var start = new ProcessStartInfo("powershell.exe");
        start.Arguments = "-NoLogo -NoProfile -NonInteractive -File \"" + args[1] + "\" -Mode Record";
        start.UseShellExecute = false;
        start.RedirectStandardInput = true;
        using (var hook = Process.Start(start))
        {
            hook.StandardInput.Write("{\"hook_event_name\":\"SessionStart\",\"session_id\":\"" + session + "\"}");
            hook.StandardInput.Close();
            hook.WaitForExit();
            if (hook.ExitCode != 0)
                return hook.ExitCode;
        }

        Console.WriteLine("Recorded " + session);
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }
}
