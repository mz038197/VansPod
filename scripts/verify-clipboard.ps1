param([string]$AppUrl, [switch]$InspectOnly)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public sealed class TimedClipboardWebClient : System.Net.WebClient {
 protected override System.Net.WebRequest GetWebRequest(Uri address) {
  var request=base.GetWebRequest(address); request.Timeout=15000;
  var http=request as System.Net.HttpWebRequest; if(http!=null)http.ReadWriteTimeout=15000;
  return request;
 }
}
public sealed class ClipboardFormatBytes {
 public uint Id; public string Name; public byte[] Bytes;
}
public static class NativeClipboardProof {
 [DllImport("user32.dll",SetLastError=true)] static extern bool OpenClipboard(IntPtr hwnd);
 [DllImport("user32.dll",SetLastError=true)] static extern bool CloseClipboard();
 [DllImport("user32.dll",SetLastError=true)] static extern uint EnumClipboardFormats(uint format);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr GetClipboardData(uint format);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClipboardFormatName(uint format,StringBuilder name,int size);
 [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
 [DllImport("kernel32.dll",SetLastError=true)] static extern UIntPtr GlobalSize(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GlobalLock(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GlobalUnlock(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GlobalAlloc(uint flags,UIntPtr count);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GlobalFree(IntPtr handle);
 [DllImport("user32.dll",SetLastError=true)] static extern bool EmptyClipboard();
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetClipboardData(uint format,IntPtr handle);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowEx(uint ex,string cls,string title,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr extra);
 [DllImport("user32.dll",SetLastError=true)] static extern bool DestroyWindow(IntPtr window);
 [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
 static void Open(IntPtr owner) { for(int i=0;i<100;i++) { if(OpenClipboard(owner)) return; Thread.Sleep(20); } throw new Exception("Clipboard busy; no content shown"); }
 public static ClipboardFormatBytes[] Capture() {
  var rows=new List<ClipboardFormatBytes>(); Open(IntPtr.Zero);
  try {
   uint id=0;
   while(true) {
    SetLastError(0); id=EnumClipboardFormats(id);
    if(id==0) { if(Marshal.GetLastWin32Error()!=0) throw new Exception("Clipboard enumeration failed"); break; }
    // Only standard memory formats and private registered formats qualify.
    // Bitmap, metafile, palette, owner-display and GDI-object formats are not HGLOBAL.
    if(id==2 || id==3 || id==9 || id==14 || id==0x80 || (id>=0x81 && id<=0x8e) || (id>=0x300 && id<=0x3ff)) throw new Exception("Unsupported non-HGLOBAL clipboard format id="+id+"; clipboard untouched");
    var handle=GetClipboardData(id); ulong size=GlobalSize(handle).ToUInt64();
    if(handle==IntPtr.Zero || size==0 || size>64*1024*1024) throw new Exception("Unsafe clipboard handle/size for id="+id+"; clipboard untouched");
    var pointer=GlobalLock(handle); if(pointer==IntPtr.Zero) throw new Exception("Clipboard handle not lockable id="+id+"; clipboard untouched");
    var bytes=new byte[(int)size]; try { Marshal.Copy(pointer,bytes,0,bytes.Length); } finally { GlobalUnlock(handle); }
    var name=new StringBuilder(256); GetClipboardFormatName(id,name,name.Capacity);
    rows.Add(new ClipboardFormatBytes { Id=id, Name=name.ToString(), Bytes=bytes });
   }
   return rows.ToArray();
  } finally { CloseClipboard(); }
 }
 public static bool Equal(ClipboardFormatBytes[] left,ClipboardFormatBytes[] right) {
  if(left.Length!=right.Length) return false;
  for(int i=0;i<left.Length;i++) { if(left[i].Id!=right[i].Id || left[i].Bytes.Length!=right[i].Bytes.Length) return false; for(int j=0;j<left[i].Bytes.Length;j++) if(left[i].Bytes[j]!=right[i].Bytes[j]) return false; }
  return true;
 }
 public static bool MatchesText(ClipboardFormatBytes[] values,string expected) {
  foreach(var value in values) if(value.Id==13) { var text=Encoding.Unicode.GetString(value.Bytes); int at=text.IndexOf('\0'); if(at>=0)text=text.Substring(0,at); return text==expected; } return false;
 }
 public static void PreflightRestore(ClipboardFormatBytes[] rows) {
  // Read-only preflight confirms hidden-owner and allocation capability before any /copy request.
  IntPtr window=IntPtr.Zero; bool opened=false;
  try {
   window=CreateWindowEx(0,"STATIC","",0,0,0,0,0,new IntPtr(-3),IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
   if(window==IntPtr.Zero) throw new Exception("Clipboard owner window unavailable; clipboard untouched");
   Open(window); opened=true;
   foreach(var row in rows) {
    var handle=GlobalAlloc(2,new UIntPtr((uint)row.Bytes.Length));
    if(handle==IntPtr.Zero) throw new Exception("Clipboard restore allocation unavailable; clipboard untouched");
    try { var ptr=GlobalLock(handle); if(ptr==IntPtr.Zero) throw new Exception("Clipboard restore lock unavailable; clipboard untouched"); try { Marshal.Copy(row.Bytes,0,ptr,row.Bytes.Length); } finally { GlobalUnlock(handle); } }
    finally { GlobalFree(handle); }
   }
  } finally { if(opened)CloseClipboard(); if(window!=IntPtr.Zero)DestroyWindow(window); }
 }
 public static void Restore(ClipboardFormatBytes[] rows) {
  // Prepare every allocation before EmptyClipboard so allocation failure cannot destroy a backup.
  var handles=new IntPtr[rows.Length]; IntPtr window=IntPtr.Zero; bool opened=false;
  try {
   for(int i=0;i<rows.Length;i++) {
    handles[i]=GlobalAlloc(2,new UIntPtr((uint)rows[i].Bytes.Length)); if(handles[i]==IntPtr.Zero) throw new Exception("Clipboard restore allocation failed");
    var ptr=GlobalLock(handles[i]); if(ptr==IntPtr.Zero) throw new Exception("Clipboard restore lock failed");
    try { Marshal.Copy(rows[i].Bytes,0,ptr,rows[i].Bytes.Length); } finally { GlobalUnlock(handles[i]); }
   }
   window=CreateWindowEx(0,"STATIC","",0,0,0,0,0,new IntPtr(-3),IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
   if(window==IntPtr.Zero) throw new Exception("Clipboard owner window unavailable; no mutation attempted");
   Open(window); opened=true;
   if(!EmptyClipboard()) throw new Exception("Clipboard empty failed during restore");
   for(int i=0;i<rows.Length;i++) {
    if(SetClipboardData(rows[i].Id,handles[i])==IntPtr.Zero) throw new Exception("Clipboard restore set-data failed id="+rows[i].Id);
    handles[i]=IntPtr.Zero; // Ownership transferred to clipboard.
   }
  } finally {
   if(opened)CloseClipboard();
   if(window!=IntPtr.Zero)DestroyWindow(window);
   foreach(var handle in handles) if(handle!=IntPtr.Zero)GlobalFree(handle);
  }
 }
 public static void ClearBackup(ClipboardFormatBytes[] values) { foreach(var value in values) Array.Clear(value.Bytes,0,value.Bytes.Length); }
}
'@

$backup = $null
$mutationAttempted = $false
$restoreVerified = $false
try {
  $sequence = [NativeClipboardProof]::GetClipboardSequenceNumber()
  $backup = @([NativeClipboardProof]::Capture())
  [NativeClipboardProof]::PreflightRestore($backup)
  if ($InspectOnly -or -not $AppUrl) {
    $metadata = @($backup | ForEach-Object { @{ id = $_.Id; name = $_.Name; size = $_.Bytes.Length; hglobalLockable = $true } })
    [Console]::Out.Write((@{ formats = $metadata; nativeBackupSupported = $true; hiddenOwnerPreflight = $true; clipboardMutated = $false } | ConvertTo-Json -Depth 4 -Compress))
    return
  }
  $uri = [Uri]$AppUrl
  if ($uri.Host -ne '127.0.0.1' -or $uri.Scheme -ne 'http') { throw 'Copy verification accepts only loopback HTTP' }
  $expected = [Console]::In.ReadToEnd()
  if (-not $expected) { throw 'Expected key stdin is empty; clipboard untouched' }
  if ([NativeClipboardProof]::GetClipboardSequenceNumber() -ne $sequence) { throw 'Clipboard changed before test; no mutation attempted' }
  $client = New-Object TimedClipboardWebClient
  $client.Headers['Content-Type'] = 'application/x-www-form-urlencoded'
  $mutationAttempted = $true
  [void]$client.UploadString(($AppUrl.TrimEnd('/') + '/copy'), 'POST', '')
  $copied = [NativeClipboardProof]::Capture()
  try { $copiedMatches = [NativeClipboardProof]::MatchesText($copied, $expected) }
  finally { [NativeClipboardProof]::ClearBackup($copied) }
} finally {
  if ($mutationAttempted -and ($null -ne $backup)) {
    for ($attempt = 0; -not $restoreVerified; $attempt++) {
      try {
        [NativeClipboardProof]::Restore($backup)
        $restored = [NativeClipboardProof]::Capture()
        try { $restoreVerified = [NativeClipboardProof]::Equal($backup, $restored) }
        finally { [NativeClipboardProof]::ClearBackup($restored) }
        if ($restoreVerified) { break }
      } catch { }
      if ($attempt -eq 7) { [Console]::Error.WriteLine('CLIPBOARD_RESTORE_PENDING: keep this helper process alive while restoration retries; original bytes remain in its memory') }
      Start-Sleep -Milliseconds 100
    }
  }
  if ($null -ne $backup) { [NativeClipboardProof]::ClearBackup($backup) }
}
if (-not $copiedMatches) { throw 'Actual app clipboard key comparison failed; original clipboard restored' }
[Console]::Out.Write((@{ actualCopyKey = $true; exactFormatsAndBytesRestored = $restoreVerified } | ConvertTo-Json -Compress))
