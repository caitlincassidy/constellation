package eclipseonut;

import java.util.HashMap;

import javax.script.Bindings;
import javax.script.SimpleBindings;

import org.eclipse.core.runtime.Assert;
import org.eclipse.jface.text.BadLocationException;
import org.eclipse.jface.text.DocumentEvent;
import org.eclipse.jface.text.IDocument;
import org.eclipse.jface.text.IDocumentListener;
import org.eclipse.jface.text.IPainter;
import org.eclipse.jface.text.ITextOperationTarget;
import org.eclipse.jface.text.ITextSelection;
import org.eclipse.jface.text.ITextViewer;
import org.eclipse.jface.text.Position;
import org.eclipse.jface.text.source.Annotation;
import org.eclipse.jface.text.source.AnnotationPainter;
import org.eclipse.jface.text.source.AnnotationPainter.IDrawingStrategy;
import org.eclipse.jface.text.source.IAnnotationAccess;
import org.eclipse.jface.text.source.IAnnotationModel;
import org.eclipse.jface.text.source.ISourceViewer;
import org.eclipse.jface.viewers.ISelection;
import org.eclipse.jface.viewers.ISelectionChangedListener;
import org.eclipse.jface.viewers.ISelectionProvider;
import org.eclipse.jface.viewers.SelectionChangedEvent;
import org.eclipse.swt.custom.CaretEvent;
import org.eclipse.swt.custom.CaretListener;
import org.eclipse.swt.custom.StyledText;
import org.eclipse.swt.graphics.Color;
import org.eclipse.swt.graphics.GC;
import org.eclipse.swt.graphics.Point;
import org.eclipse.swt.widgets.Control;
import org.eclipse.swt.widgets.Display;
import org.eclipse.ui.texteditor.ITextEditor;

public class ShareDoc implements IDocumentListener {
    
    private final JSEngine js;
    private final IDocument local;
    private final Bindings env = new SimpleBindings();
    private boolean syncing = false;
    private final IAnnotationModel annotationModel;
    private final HashMap<Integer, Position> cursorMap = new HashMap<>();
    private final AnnotationPainter painter;
    
    public ShareDoc(JSEngine js, IDocument local, Object contexts, ITextEditor editor) {
        this.js = js;
        this.local = local;
        env.put("contexts", contexts);
        env.put("sharedoc", this);
        
        // Set up the caret drawer for remote caret moves
        ITextViewer viewer = (ITextViewer)editor.getAdapter(ITextOperationTarget.class);
        AnnotationPainter painter = new AnnotationPainter((ISourceViewer) viewer, new IAnnotationAccess() {
            @Override
            public boolean isTemporary(Annotation annotation) {
                return annotation.isPersistent();
            }
            
            @Override
            public boolean isMultiLine(Annotation annotation) {
                return true;
            }
            
            @Override
            public Object getType(Annotation annotation) {
                return annotation.getType();
            }
        });
        this.painter = painter;
        painter.addAnnotationType("caret", "caret");
        painter.addDrawingStrategy("caret", new IDrawingStrategy() {
            private static final int CURSOR_WIDTH = 2;
            @Override
            public void draw(Annotation annotation, GC gc, StyledText textWidget, int offset, int length, Color color) {
                Point cursor = textWidget.getLocationAtOffset(offset);
                if (gc == null) {
                    textWidget.redraw(cursor.x - CURSOR_WIDTH / 2,
                        cursor.y, CURSOR_WIDTH + 1,
                        textWidget.getLineHeight(), false);
                    return;
                }

                final Color foreground = gc.getForeground();
                // instead of setting foreground to the color passed in, we use red to
                // indicate remotely called cursors.
                final Color cursorColor = new Color(gc.getDevice(), 255, 0, 0);
                gc.setForeground(cursorColor);
                gc.setLineWidth(CURSOR_WIDTH);
                gc.drawLine(cursor.x, cursor.y,
                    cursor.x,
                    cursor.y + textWidget.getLineHeight());
                gc.setForeground(foreground);
                foreground.dispose();
                cursorColor.dispose();
            }
        });
        
        painter.setAnnotationTypeColor("caret", viewer.getTextWidget().getForeground());
        painter.paint(IPainter.CONFIGURATION);
        this.annotationModel = ((ISourceViewer) viewer).getAnnotationModel();
        
        ISelectionProvider selectionProvider = editor.getSelectionProvider();
        selectionProvider.addSelectionChangedListener(new ISelectionChangedListener() {
            @Override
            public void selectionChanged(SelectionChangedEvent event) {
                ISelection selection = selectionProvider.getSelection();
                if (selection instanceof ITextSelection) {
                    ITextSelection textSelection = (ITextSelection)selection;
                    int offset = textSelection.getOffset();
                    System.out.println("Selection Offset: " + offset);
                }
            }
        });
        
        // XXX: used as part of interim user ID below. Needs to be here to avoid
        // scoping issues with "this".
        int hashCode = this.hashCode();
        
        StyledText text = (StyledText)editor.getAdapter(Control.class);
        text.addCaretListener(new CaretListener() {
            @Override
            public void caretMoved(CaretEvent event) {
                System.out.println("Caret Offset: " + event.caretOffset);
                js.exec((engine) -> {
                    // XXX: temporarily use ShareDoc's hashcode to ID users uniquely
                    // Need to fetch userID from ShareJS class.
                    env.put("userId", hashCode);
                    env.put("offset", event.caretOffset);
                    engine.eval("contexts.cursors.caretMoved(userId, offset)", env);
                });
            }
        });
        
        js.exec((engine) -> {
            env.put("attach", engine.get("attach"));
            String current = (String)engine.eval("attach(contexts, sharedoc)", env);
            if ( ! local.get().equals(current)) {
                local.set(current);
            }
        });
        
        local.addDocumentListener(this);
    }

    public void close() {
        local.removeDocumentListener(this);
        
        js.exec((engine) -> {
            env.put("detach", engine.get("detach"));
            engine.eval("detach(contexts, sharedoc)", env);
        });
    }
    
    public void onRemoteInsert(int pos, String text) {
        Assert.isNotNull(Display.getCurrent());
        syncing = true;
        try {
            local.replace(pos, 0, text);
        } catch (BadLocationException ble) {
            Log.error("Bad location on remote insert " + pos + " (" + text.length() + ")", ble);
        }
        syncing = false;
    }
    
    public void onRemoteRemove(int pos, int length) {
        Assert.isNotNull(Display.getCurrent());
        syncing = true;
        try {
            local.replace(pos, length, "");
        } catch (BadLocationException ble) {
            Log.error("Bad location on remote remove " + pos + " " + length, ble);
        }
        syncing = false;
    }
    
    public void onRemoteCaretMove(int userId, int remoteOffset) {
        Assert.isNotNull(Display.getCurrent());
        // TODO: modify this userId check to actually use id, see above usage of hashcode
        if (userId != this.hashCode()) {
            // the AnnotationPainter API does not appear to offer a better way to remove
            // previously drawn cursors, so we call decativate(true) to do so.
            painter.deactivate(true);
            System.out.println("Remote offset " + remoteOffset);
            if (cursorMap.containsKey(userId)) {
                cursorMap.get(userId).setOffset(remoteOffset);
            } else {
                Annotation annotation = new Annotation("caret", true, "");
                Position position = new Position(remoteOffset);
                annotationModel.addAnnotation(annotation, position);
                cursorMap.put(userId, position);
            }
            painter.paint(IPainter.CONFIGURATION);
        }
    }
    
    private void onLocalInsert(int pos, String text) {
        Assert.isNotNull(Display.getCurrent());
        js.exec((engine) -> {
            env.put("pos", pos);
            env.put("text", text);
            engine.eval("contexts.text.insert(pos, text)", env);
        });
    }
    
    private void onLocalRemove(int pos, int length) {
        Assert.isNotNull(Display.getCurrent());
        js.exec((engine) -> {
            env.put("pos", pos);
            env.put("length", length);
            engine.eval("contexts.text.remove(pos, length)", env);
        });
    }
    
    public void documentAboutToBeChanged(DocumentEvent event) { }
    public void documentChanged(DocumentEvent event) {
        if (syncing) { return; }
        if (event.getLength() > 0) {
            onLocalRemove(event.getOffset(), event.getLength());
        }
        if ( ! event.getText().isEmpty()) {
            onLocalInsert(event.getOffset(), event.getText());
        }
    }
}
